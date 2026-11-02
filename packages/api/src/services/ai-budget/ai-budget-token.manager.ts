import { randomUUID } from 'crypto';
import type { RedisLike } from '../../lib/redis';
import { logger } from '../../utils/logger';
import type { CryptoService } from '../crypto.service';
import { AiBudgetApiError, AiBudgetNotConnectedError, AiBudgetReconnectRequiredError } from './ai-budget-errors';
import type { AiBudgetOAuthClient } from './ai-budget-oauth.client';
import type { TokenResponse } from './ai-budget.types';

export interface ConnectionRow {
  id: string;
  userId: string;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  accessTokenExpiresAt: Date | null;
  scope: string | null;
  status: 'active' | 'needs_reconnect' | 'revoked';
  statusChangedAt: Date;
  needsCompanyChoice: boolean;
}

export interface StoredTokens {
  accessTokenEnc: string;
  refreshTokenEnc: string;
  accessTokenExpiresAt: Date;
  scope: string;
}

/** The token store is declared here; Task 4's AiBudgetRepository extends it. */
export interface TokenStore {
  getConnection(userId: string): Promise<ConnectionRow | null>;
  /** Sets status → active and statusChangedAt → now. */
  upsertConnectionTokens(userId: string, t: StoredTokens): Promise<ConnectionRow>;
  /**
   * Compare-and-swap: writes only while the stored refresh token ciphertext still equals
   * `previousRefreshTokenEnc` and the connection is not revoked. Returns whether a row was updated.
   */
  updateTokens(connectionId: string, previousRefreshTokenEnc: string, t: StoredTokens): Promise<boolean>;
  /** A `revoked` connection only accepts `revoked`: a racing refresh cannot turn a disconnect into needs_reconnect. */
  setConnectionStatus(userId: string, status: ConnectionRow['status'], at: Date): Promise<void>;
}

export interface TokenManagerOptions {
  lockTtlMs?: number;
  waitMs?: number;
  pollMs?: number;
  skewMs?: number;
  now?: () => Date;
  /** How long a refresh with an unknown outcome blocks further refreshes. */
  unknownOutcomeTtlSec?: number;
  saveAttempts?: number;
  saveRetryDelayMs?: number;
}

/** Called after a refresh has saved the rotated pair, with the authoritative `account_ids`. */
export type AccountIdsListener = (userId: string, accountIds: string[]) => Promise<void>;

const lockKey = (userId: string): string => `aib:refresh:${userId}`;
/** Set when a refresh failed without a readable answer: it may have rotated the pair at AI Budget. */
const unknownKey = (userId: string): string => `aib:refresh-unknown:${userId}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A loggable code for a storage error: never its message (it can echo SQL parameters). */
const errCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
  return err instanceof Error ? err.name : 'unknown_error';
};

/**
 * Hands out access tokens and refreshes them under the per-user Redis lock `aib:refresh:{userId}`.
 * AI Budget revokes the whole connection when a refresh token is reused, so two refreshes for
 * one user must never run at once, and the rotated pair is saved before anything else happens.
 */
export class AiBudgetTokenManager {
  private readonly lockTtlMs: number;
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly skewMs: number;
  private readonly now: () => Date;
  private readonly unknownOutcomeTtlSec: number;
  private readonly saveAttempts: number;
  private readonly saveRetryDelayMs: number;
  private accountIdsListener: AccountIdsListener | null = null;

  constructor(
    private readonly store: TokenStore,
    private readonly crypto: CryptoService,
    private readonly redis: RedisLike,
    private readonly oauth: AiBudgetOAuthClient,
    opts: TokenManagerOptions = {},
  ) {
    this.lockTtlMs = opts.lockTtlMs ?? 30000;
    this.waitMs = opts.waitMs ?? 10000;
    this.pollMs = opts.pollMs ?? 200;
    this.skewMs = opts.skewMs ?? 60000;
    this.now = opts.now ?? (() => new Date());
    this.unknownOutcomeTtlSec = opts.unknownOutcomeTtlSec ?? 60;
    this.saveAttempts = opts.saveAttempts ?? 3;
    this.saveRetryDelayMs = opts.saveRetryDelayMs ?? 100;
  }

  /**
   * `account_ids` in a token response is authoritative; the listener re-syncs the account list
   * when it changed. It runs after the lock is released and before the new token is returned.
   */
  setAccountIdsListener(fn: AccountIdsListener): void {
    this.accountIdsListener = fn;
  }

  async getAccessToken(userId: string): Promise<string> {
    const conn = this.usable(await this.store.getConnection(userId));
    if (this.isFresh(conn)) return this.crypto.decryptFromString(conn.accessTokenEnc!);
    return this.refreshLocked(userId, (c) => !this.isFresh(c));
  }

  /** After a 401: refreshes only if the stored access token is still the one that was rejected. */
  async forceRefresh(userId: string, staleAccessToken: string): Promise<string> {
    return this.refreshLocked(userId, (_c, access) => access === staleAccessToken);
  }

  /**
   * A (re)connect saves its pair under the same per-user refresh lock, so a refresh of the old grant
   * that is still in flight cannot overwrite it. If the lock stays held past the wait, the save goes
   * ahead anyway: `updateTokens` is a compare-and-swap, so the late refresh then matches no row.
   */
  async saveInitialTokens(userId: string, tokens: TokenResponse): Promise<void> {
    const key = lockKey(userId);
    const owner = randomUUID();
    const deadline = Date.now() + this.waitMs;
    let locked = await this.redis.setNxPx(key, owner, this.lockTtlMs);
    while (!locked && Date.now() < deadline) {
      await sleep(this.pollMs);
      locked = await this.redis.setNxPx(key, owner, this.lockTtlMs);
    }
    if (!locked) logger.warn('AI Budget refresh lock still held while saving new tokens', { userId, code: 'refresh_in_progress' });
    try {
      await this.store.upsertConnectionTokens(userId, this.encrypt(tokens));
      // A new grant: an unknown outcome of the old grant's refresh no longer matters.
      await this.redis.del(unknownKey(userId)).catch(() => undefined);
    } finally {
      if (locked) await this.redis.delIfEquals(key, owner);
    }
  }

  private usable(conn: ConnectionRow | null): ConnectionRow {
    if (!conn || conn.status === 'revoked' || !conn.accessTokenEnc || !conn.refreshTokenEnc) throw new AiBudgetNotConnectedError();
    if (conn.status === 'needs_reconnect') throw new AiBudgetReconnectRequiredError();
    return conn;
  }

  private isFresh(conn: ConnectionRow): boolean {
    return !!conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() - this.now().getTime() > this.skewMs;
  }

  private encrypt(t: TokenResponse): StoredTokens {
    return {
      accessTokenEnc: this.crypto.encryptToString(t.access_token),
      refreshTokenEnc: this.crypto.encryptToString(t.refresh_token),
      accessTokenExpiresAt: new Date(this.now().getTime() + t.expires_in * 1000),
      scope: t.scope,
    };
  }

  /**
   * `needsRefresh(conn, storedAccessToken)` is evaluated on a fresh read of the store, both inside
   * the lock and after waiting for another holder, so a refresh done elsewhere is reused.
   */
  private async refreshLocked(
    userId: string,
    needsRefresh: (conn: ConnectionRow, storedAccess: string) => boolean,
  ): Promise<string> {
    const key = lockKey(userId);
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      const owner = randomUUID();
      if (await this.redis.setNxPx(key, owner, this.lockTtlMs)) {
        return this.refreshHoldingLock(userId, key, owner, needsRefresh);
      }
      // Another worker is refreshing: wait for it, then reuse what it saved.
      while (Date.now() < deadline && (await this.redis.get(key)) !== null) await sleep(this.pollMs);
      const conn = this.usable(await this.store.getConnection(userId));
      const access = this.crypto.decryptFromString(conn.accessTokenEnc!);
      if (!needsRefresh(conn, access)) return access;
      if (Date.now() >= deadline) {
        if (await this.redis.setNxPx(key, owner, this.lockTtlMs)) {
          return this.refreshHoldingLock(userId, key, owner, needsRefresh);
        }
        logger.warn('AI Budget token refresh lock still held after waiting', { userId });
        throw new AiBudgetApiError(503, 'refresh_in_progress');
      }
    }
  }

  private async refreshHoldingLock(
    userId: string,
    key: string,
    owner: string,
    needsRefresh: (conn: ConnectionRow, storedAccess: string) => boolean,
  ): Promise<string> {
    let rotated: TokenResponse;
    let saved = false;
    try {
      const conn = this.usable(await this.store.getConnection(userId));
      const access = this.crypto.decryptFromString(conn.accessTokenEnc!);
      if (!needsRefresh(conn, access)) return access;
      // A previous refresh may have rotated the pair at AI Budget without us learning the new one:
      // presenting the same refresh token again now could revoke the whole connection.
      if ((await this.redis.get(unknownKey(userId))) !== null) {
        logger.warn('AI Budget token refresh outcome still unknown; not refreshing', { userId, code: 'refresh_in_progress' });
        throw new AiBudgetApiError(503, 'refresh_in_progress');
      }
      try {
        rotated = await this.oauth.refresh(this.crypto.decryptFromString(conn.refreshTokenEnc!));
      } catch (err) {
        if (err instanceof AiBudgetApiError && err.code === 'invalid_grant') {
          await this.store.setConnectionStatus(userId, 'needs_reconnect', this.now());
          logger.warn('AI Budget refresh rejected; connection needs reconnect', { userId, status: err.status, code: err.code });
          throw new AiBudgetReconnectRequiredError();
        }
        // A 5xx (often an edge proxy's 502/503/504) may hide a rotation that happened: unknown outcome.
        const known = err instanceof AiBudgetApiError && err.status > 0 && err.status < 500 && err.code !== 'invalid_token_response';
        const status = err instanceof AiBudgetApiError ? err.status : 0;
        const code = err instanceof AiBudgetApiError ? err.code : 'network_error';
        if (!known) {
          // A Redis error here must not mask the refresh error.
          await this.redis.setEx(unknownKey(userId), this.unknownOutcomeTtlSec, '1').catch((markerErr: unknown) => {
            logger.error('AI Budget unknown-outcome marker could not be set', { userId, code: errCode(markerErr) });
          });
        }
        logger.warn('AI Budget token refresh failed', { userId, status, code });
        throw err;
      }
      // The old refresh token is spent from here on: persist the new pair before anything else.
      saved = await this.saveRotated(userId, conn.id, conn.refreshTokenEnc!, this.encrypt(rotated));
    } finally {
      await this.redis.delIfEquals(key, owner);
    }
    if (!saved) {
      // Someone else saved a pair in the meantime (a reconnect, or a refresh after our lock expired):
      // theirs is authoritative. Use it; do not fail the connection.
      logger.warn('AI Budget rotated tokens superseded by a newer save', { userId, code: 'token_superseded' });
      const current = this.usable(await this.store.getConnection(userId));
      return this.crypto.decryptFromString(current.accessTokenEnc!);
    }
    if (this.accountIdsListener) await this.accountIdsListener(userId, rotated.account_ids);
    return rotated.access_token;
  }

  /**
   * Saves the rotated pair, retrying while the lock is held. Returns false when the compare-and-swap
   * found a different refresh token (someone else saved meanwhile). If it cannot be saved, the stored
   * refresh token is spent: the connection is marked needs_reconnect so nobody presents it again.
   */
  private async saveRotated(userId: string, connectionId: string, previousRefreshTokenEnc: string, tokens: StoredTokens): Promise<boolean> {
    for (let attempt = 1; attempt <= this.saveAttempts; attempt++) {
      try {
        return await this.store.updateTokens(connectionId, previousRefreshTokenEnc, tokens);
      } catch (err) {
        logger.warn('AI Budget rotated token save attempt failed', { userId, attempt, code: errCode(err) });
        if (attempt < this.saveAttempts) await sleep(this.saveRetryDelayMs * attempt);
      }
    }
    logger.error('AI Budget rotated tokens could not be saved', { userId, code: 'token_save_failed' });
    try {
      await this.store.setConnectionStatus(userId, 'needs_reconnect', this.now());
    } catch {
      // Last line of defence: block refreshes for this user while the marker lives.
      await this.redis.setEx(unknownKey(userId), this.unknownOutcomeTtlSec, '1').catch(() => undefined);
      logger.error('AI Budget connection could not be marked needs_reconnect', { userId, code: 'token_save_failed' });
    }
    throw new AiBudgetApiError(500, 'token_save_failed');
  }
}
