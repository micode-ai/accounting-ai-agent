import { createHash, randomBytes } from 'crypto';
import type { RedisLike } from '../../lib/redis';
import type { AiBudgetAccountDto, AiBudgetStatusDto } from '../../types/ai-budget-api.types';
import { logger } from '../../utils/logger';
import type { CryptoService } from '../crypto.service';
import { AI_BUDGET_SCOPES, type AiBudgetConfig } from './ai-budget.config';
import type { AccountRow, AiBudgetRepository } from './ai-budget.repository';
import type { AiBudgetAccountsService } from './ai-budget-accounts.service';
import { AiBudgetApiError } from './ai-budget-errors';
import type { AiBudgetOAuthClient } from './ai-budget-oauth.client';
import type { AiBudgetLiveReadService } from './ai-budget-live.service';
import type { AiBudgetMirrorSyncService } from './ai-budget-sync.service';
import type { AiBudgetTokenManager } from './ai-budget-token.manager';
import type { TokenResponse } from './ai-budget.types';

export const OAUTH_STATE_TTL_SECONDS = 600;

/** 16 random bytes in base64url. */
const STATE_RE = /^[A-Za-z0-9_-]{22}$/;
const VERIFIER_RE = /^[A-Za-z0-9_-]{43}$/;
const stateKey = (state: string): string => `aib:oauth:state:${state}`;
const reconCacheKey = (userId: string): string => `aib:recon:${userId}`;

/** An authorization code as it may appear in a URL: printable ASCII, bounded. */
const CODE_RE = /^[!-~]{1,512}$/;

export type CallbackErrorReason = 'invalid_state' | 'access_denied' | 'exchange_failed' | 'unavailable';
export type CompleteErrorReason = 'invalid_state' | 'state_mismatch' | 'exchange_failed';
export type CompleteResult = { ok: true } | { ok: false; reason: CompleteErrorReason };
interface BoundState { userId: string; verifier: string }

/**
 * `remote`: `revoked` — AI Budget confirmed the revoke; `failed` — an active grant could not be revoked;
 * `expired` — the grant was already unusable (needs_reconnect) and the revoke was not confirmed;
 * `none` — there was no stored grant to revoke.
 */
export interface DisconnectResult {
  revokedRemotely: boolean;
  remote: 'revoked' | 'failed' | 'expired' | 'none';
}

/** The integration is not configured on this server. */
export class AiBudgetUnavailableError extends Error {
  constructor() {
    super('AI Budget integration is not available');
    this.name = 'AiBudgetUnavailableError';
  }
}

/** RFC 7636 S256: a 32-byte base64url verifier and base64url(sha256(verifier)) as the challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function toAccountDto(a: AccountRow): AiBudgetAccountDto {
  return {
    id: a.id, externalId: a.externalId, name: a.name, type: a.type, currency: a.currency, access: a.access,
    active: a.active, inactiveReason: a.inactiveReason, label: a.label, labelSource: a.labelSource,
  };
}

/** Short, content-free description of a failure for logs. */
function failure(err: unknown): { status: number; code: string } {
  if (err instanceof AiBudgetApiError) return { status: err.status, code: err.code };
  return { status: 0, code: err instanceof Error ? err.name : 'unknown' };
}

export interface AiBudgetOAuthDeps {
  redis: RedisLike;
  oauth: AiBudgetOAuthClient;
  tokens: AiBudgetTokenManager;
  /** Decrypts the stored refresh token for the revoke on disconnect. */
  crypto: CryptoService;
  accounts: AiBudgetAccountsService;
  sync: AiBudgetMirrorSyncService;
  repo: AiBudgetRepository;
  /** Live-read cache, invalidated for every account on disconnect. */
  live?: Pick<AiBudgetLiveReadService, 'invalidate'>;
}

/**
 * The OAuth connect/complete/disconnect flow. The `state` is bound to the user who started the connect:
 * it is single-use (read with GETDEL), expires after 600 s and carries the PKCE verifier, which never
 * leaves the server. The code is exchanged only in `completeConnect`, for the same signed-in user.
 */
export class AiBudgetOAuthService {
  constructor(private readonly config: AiBudgetConfig | null, private readonly deps: AiBudgetOAuthDeps) {}

  async getStatus(userId: string): Promise<AiBudgetStatusDto> {
    if (!this.config) return { available: false, connection: null };
    const { repo, accounts } = this.deps;
    let conn = await repo.getConnection(userId);
    if (!conn || conn.status === 'revoked') return { available: true, connection: null };

    if (conn.status === 'active') {
      try {
        await accounts.syncAccountList(userId);
      } catch (err) {
        logger.warn('AI Budget account list refresh for status failed', { userId, ...failure(err) });
      }
      // The re-sync may have changed needsCompanyChoice, or found the connection lost.
      conn = await repo.getConnection(userId);
      if (!conn || conn.status === 'revoked') return { available: true, connection: null };
    }

    const rows = await repo.listAccounts(userId);
    const company = rows.find((a) => a.label === 'company') ?? null;
    return {
      available: true,
      connection: {
        status: conn.status,
        lastSyncedAt: company?.lastSyncedAt ? company.lastSyncedAt.toISOString() : null,
        lastSyncError: company?.lastSyncError ?? null,
        needsCompanyChoice: conn.needsCompanyChoice,
        accounts: rows.map(toAccountDto),
      },
    };
  }

  async startConnect(userId: string): Promise<{ authorizeUrl: string }> {
    const config = this.requireConfig();
    const state = randomBytes(16).toString('base64url');
    const { verifier, challenge } = pkcePair();
    await this.deps.redis.setEx(stateKey(state), OAUTH_STATE_TTL_SECONDS, JSON.stringify({ userId, verifier }));

    const url = new URL(config.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('scope', AI_BUDGET_SCOPES);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { authorizeUrl: url.toString() };
  }

  /**
   * The unauthenticated OAuth redirect target. It never exchanges the code: the state is bound to the user
   * who started the connect, not to the browser finishing it, so the code goes to the web app, which
   * POSTs it to the authenticated `completeConnect` (Ruling 8). Never throws; returns the redirect URL.
   */
  async handleCallback(query: { code?: string; state?: string; error?: string }): Promise<string> {
    const config = this.config;
    if (!config) {
      const frontend = (process.env.FRONTEND_URL ?? '').trim().replace(/\/+$/, '');
      return `${frontend}/settings/integrations?ai_budget=error&reason=unavailable`;
    }
    const fail = (reason: CallbackErrorReason): string =>
      `${config.frontendUrl}/settings/integrations?ai_budget=error&reason=${reason}`;

    if (query.error) {
      // The user declined (or AI Budget failed): the state is consumed so it cannot be completed later.
      let bound: BoundState | null;
      try {
        bound = await this.consumeState(query.state);
      } catch (err) {
        logger.warn('AI Budget OAuth state lookup failed', failure(err));
        return fail('invalid_state');
      }
      if (!bound) return fail('invalid_state');
      const reason = query.error === 'access_denied' ? 'access_denied' : 'exchange_failed';
      logger.info('AI Budget authorization not granted', { userId: bound.userId, code: reason });
      return fail(reason);
    }
    if (typeof query.state !== 'string' || !STATE_RE.test(query.state)) return fail('invalid_state');
    if (typeof query.code !== 'string' || !CODE_RE.test(query.code)) return fail('exchange_failed');

    const params = new URLSearchParams({ code: query.code, state: query.state });
    return `${config.frontendUrl}/settings/integrations/ai-budget/complete?${params.toString()}`;
  }

  /**
   * Called by the signed-in user's browser with the code and state from the callback. The state is
   * consumed (GETDEL) whatever happens next, and must have been issued to this same user.
   */
  async completeConnect(userId: string, input: { code: string; state: string }): Promise<CompleteResult> {
    this.requireConfig();
    let bound: BoundState | null;
    try {
      bound = await this.consumeState(input.state);
    } catch (err) {
      logger.warn('AI Budget OAuth state lookup failed', failure(err));
      return { ok: false, reason: 'invalid_state' };
    }
    if (!bound) return { ok: false, reason: 'invalid_state' };
    if (bound.userId !== userId) {
      logger.warn('AI Budget OAuth state used by another user', { userId, code: 'state_mismatch' });
      return { ok: false, reason: 'state_mismatch' };
    }
    if (!CODE_RE.test(input.code)) return { ok: false, reason: 'exchange_failed' };

    let tokens: TokenResponse;
    try {
      tokens = await this.deps.oauth.exchangeCode(input.code, bound.verifier);
    } catch (err) {
      logger.warn('AI Budget code exchange failed', { userId, ...failure(err) });
      return { ok: false, reason: 'exchange_failed' };
    }
    try {
      // A reconnect replaces the stored pair. The previous tokens are NOT revoked: a revoke at
      // AI Budget ends the whole connection, including the pair just issued.
      await this.deps.tokens.saveInitialTokens(userId, tokens);
    } catch (err) {
      logger.error('AI Budget tokens could not be saved after the code exchange', { userId, ...failure(err), reason: 'token_save_failed' });
      return { ok: false, reason: 'exchange_failed' };
    }

    try {
      // account_ids is authoritative; /accounts is re-read here, which also drops accounts no longer granted.
      await this.deps.accounts.syncAccountList(userId);
    } catch (err) {
      logger.warn('AI Budget account list sync after connect failed', { userId, ...failure(err) });
    }
    void this.deps.sync.syncCompany(userId, { fullResync: true }).catch((err: unknown) => {
      logger.warn('AI Budget first sync after connect failed', { userId, ...failure(err) });
    });
    logger.info('AI Budget connected', { userId });
    return { ok: true };
  }

  /**
   * Marks the connection revoked locally first (so a running sync stops writing and a racing refresh
   * cannot resurrect it), then revokes at AI Budget with the refresh token held in memory (a failure is
   * tolerated and reported), then clears every account's mirror, cursor and dismissals, then the tokens.
   * Account rows stay so manual labels survive a reconnect.
   */
  async disconnect(userId: string): Promise<DisconnectResult> {
    this.requireConfig();
    const { repo, redis, oauth, crypto } = this.deps;
    const conn = await repo.getConnection(userId);
    // A needs_reconnect grant is already unusable: a failed revoke there is not a "could not revoke" warning.
    const expired = conn?.status === 'needs_reconnect';

    let refreshToken: string | null = null;
    let remote: DisconnectResult['remote'] = 'none';
    if (conn?.refreshTokenEnc && conn.status !== 'revoked') {
      try {
        refreshToken = crypto.decryptFromString(conn.refreshTokenEnc);
      } catch (err) {
        remote = expired ? 'expired' : 'failed';
        logger.warn('AI Budget refresh token could not be decrypted for the revoke', { userId, ...failure(err) });
      }
    }
    if (conn) await repo.setConnectionStatus(userId, 'revoked', new Date());

    if (refreshToken) {
      try {
        await oauth.revoke(refreshToken);
        remote = 'revoked';
      } catch (err) {
        remote = expired ? 'expired' : 'failed';
        logger.warn('AI Budget revoke on disconnect failed; clearing locally', { userId, ...failure(err) });
      }
    }

    // clearMirror waits for an in-flight page, then deletes the mirror rows and dismissals and resets the cursor.
    for (const a of await repo.listAccounts(userId)) {
      await repo.clearMirror(a.id);
      try {
        await this.deps.live?.invalidate(userId, a.id);
      } catch (err) {
        logger.warn('AI Budget live cache could not be invalidated on disconnect', { userId, ...failure(err) });
      }
    }
    await repo.clearTokens(userId);
    try {
      await redis.del(reconCacheKey(userId));
    } catch (err) {
      logger.warn('AI Budget reconciliation cache could not be cleared on disconnect', { userId, ...failure(err) });
    }
    logger.info('AI Budget disconnected', { userId, remote });
    return { revokedRemotely: remote === 'revoked', remote };
  }

  private requireConfig(): AiBudgetConfig {
    if (!this.config) throw new AiBudgetUnavailableError();
    return this.config;
  }

  /** Atomically reads and deletes the state; null for a missing, unknown, expired or malformed one. */
  private async consumeState(state: string | undefined): Promise<BoundState | null> {
    if (typeof state !== 'string' || !STATE_RE.test(state)) return null;
    const raw = await this.deps.redis.getDel(stateKey(state));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { userId?: unknown; verifier?: unknown };
      if (typeof parsed.userId !== 'string' || !parsed.userId) return null;
      if (typeof parsed.verifier !== 'string' || !VERIFIER_RE.test(parsed.verifier)) return null;
      return { userId: parsed.userId, verifier: parsed.verifier };
    } catch {
      return null;
    }
  }
}
