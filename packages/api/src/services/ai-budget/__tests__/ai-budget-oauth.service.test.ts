import { createHash } from 'crypto';
import { CryptoService } from '../../crypto.service';
import { AiBudgetAccountsService } from '../ai-budget-accounts.service';
import { AiBudgetApiClient } from '../ai-budget-api.client';
import type { AiBudgetConfig } from '../ai-budget.config';
import { AiBudgetOAuthClient } from '../ai-budget-oauth.client';
import { AiBudgetOAuthService, AiBudgetUnavailableError, OAUTH_STATE_TTL_SECONDS, pkcePair } from '../ai-budget-oauth.service';
import { AiBudgetMirrorSyncService } from '../ai-budget-sync.service';
import { AiBudgetTokenManager } from '../ai-budget-token.manager';
import type { RemoteAccount } from '../ai-budget.types';
import { FakeRedis, FakeTransport, InMemoryAiBudgetRepository } from './fakes';

process.env.CREDENTIALS_ENCRYPTION_KEY = 'a'.repeat(64);

const config: AiBudgetConfig = {
  clientId: 'cid', clientSecret: 'csecret', apiUrl: 'https://api.ai-budget.pl', authorizeUrl: 'https://app.ai-budget.pl/authorize',
  tokenUrl: 'https://api.ai-budget.pl/oauth/token', revokeUrl: 'https://api.ai-budget.pl/oauth/revoke',
  redirectUri: 'https://api.eksiegowyai.pl/api/integrations/ai-budget/callback', frontendUrl: 'https://eksiegowyai.pl',
};
const TOKEN = 'POST /oauth/token';
const REVOKE = 'POST /oauth/revoke';
const ACCOUNTS = 'GET /public/v1/accounts';
const errorUrl = (reason: string): string => `https://eksiegowyai.pl/settings/integrations?ai_budget=error&reason=${reason}`;
const tokenBody = (n = 1, accountIds: string[] = ['b1']) => ({
  access_token: `aba_at_${n}`, refresh_token: `aba_rt_${n}`, expires_in: 3600, scope: 'expenses:read', account_ids: accountIds,
});
const remote = (id: string, type: string): RemoteAccount => ({
  id, name: id.toUpperCase(), type, base_currency: 'PLN', access: 'read', active: true, reason: null,
});

let crypto: CryptoService;
let repo: InMemoryAiBudgetRepository;
let redis: FakeRedis;
let transport: FakeTransport;
let tokens: AiBudgetTokenManager;
let accounts: { syncAccountList: jest.Mock };
let sync: { syncCompany: jest.Mock };
let svc: AiBudgetOAuthService;

function build(over: { accounts?: unknown; sync?: unknown; config?: AiBudgetConfig | null } = {}): AiBudgetOAuthService {
  const oauth = new AiBudgetOAuthClient(config, transport);
  return new AiBudgetOAuthService(over.config === undefined ? config : over.config, {
    redis, oauth, tokens, crypto, repo,
    accounts: (over.accounts ?? accounts) as AiBudgetAccountsService,
    sync: (over.sync ?? sync) as AiBudgetMirrorSyncService,
  });
}

beforeEach(() => {
  crypto = new CryptoService();
  repo = new InMemoryAiBudgetRepository();
  redis = new FakeRedis();
  transport = new FakeTransport();
  tokens = new AiBudgetTokenManager(repo, crypto, redis, new AiBudgetOAuthClient(config, transport));
  accounts = { syncAccountList: jest.fn().mockResolvedValue({ accounts: [], dropped: [], needsCompanyChoice: false, companyChanged: false }) };
  sync = { syncCompany: jest.fn().mockResolvedValue('synced') };
  svc = build();
});

/** Starts a connect for u1 and returns the issued state and the verifier stored with it. */
async function begin(userId = 'u1'): Promise<{ state: string; verifier: string; challenge: string }> {
  const { authorizeUrl } = await svc.startConnect(userId);
  const p = new URL(authorizeUrl).searchParams;
  const state = p.get('state')!;
  const stored = JSON.parse((await redis.get(`aib:oauth:state:${state}`))!);
  return { state, verifier: stored.verifier, challenge: p.get('code_challenge')! };
}

describe('pkcePair', () => {
  test('verifier is 32 random bytes in base64url and the challenge is its S256 hash', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toHaveLength(43);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(pkcePair().verifier).not.toBe(verifier);
  });
});

describe('startConnect', () => {
  test('builds the authorize URL with PKCE S256, exact scopes and a stored state', async () => {
    const { authorizeUrl } = await svc.startConnect('u1');
    const u = new URL(authorizeUrl);
    const p = u.searchParams;
    expect(u.origin + u.pathname).toBe('https://app.ai-budget.pl/authorize');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe('cid');
    expect(p.get('scope')).toBe('expenses:read expenses:write categories:read receipts:read');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toHaveLength(43);
    expect(p.get('redirect_uri')).toBe('https://api.eksiegowyai.pl/api/integrations/ai-budget/callback');
    expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const stored = JSON.parse((await redis.get(`aib:oauth:state:${p.get('state')}`))!);
    expect(stored).toMatchObject({ userId: 'u1' });
    expect(createHash('sha256').update(stored.verifier).digest('base64url')).toBe(p.get('code_challenge'));
    // The verifier itself never leaves the server.
    expect(authorizeUrl).not.toContain(stored.verifier);
  });

  test('the state expires after OAUTH_STATE_TTL_SECONDS', async () => {
    expect(OAUTH_STATE_TTL_SECONDS).toBe(600);
    const { state } = await begin();
    redis.advance(599_000);
    expect(await redis.get(`aib:oauth:state:${state}`)).not.toBeNull();
    redis.advance(1_000);
    expect(await redis.get(`aib:oauth:state:${state}`)).toBeNull();
  });

  test('each connect gets its own state', async () => {
    const a = await begin();
    const b = await begin();
    expect(a.state).not.toBe(b.state);
  });

  test('throws unavailable when the config is null', async () => {
    await expect(build({ config: null }).startConnect('u1')).rejects.toBeInstanceOf(AiBudgetUnavailableError);
  });
});

describe('handleCallback (redirect only, no exchange)', () => {
  test('forwards code and state to the web completion page without consuming the state or exchanging', async () => {
    const { state } = await begin();
    const url = await svc.handleCallback({ code: 'c/d+e&f', state });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://eksiegowyai.pl/settings/integrations/ai-budget/complete');
    expect(u.searchParams.get('code')).toBe('c/d+e&f');
    expect(u.searchParams.get('state')).toBe(state);
    expect(await redis.get(`aib:oauth:state:${state}`)).not.toBeNull();
    expect(transport.requests).toHaveLength(0);
    expect(repo.connections.size).toBe(0);
  });

  test('a malformed or missing state redirects with reason=invalid_state', async () => {
    for (const state of [undefined, '', '../../x', 'a'.repeat(500)]) {
      expect(await svc.handleCallback({ code: 'c', state })).toBe(errorUrl('invalid_state'));
    }
  });

  test('a missing or malformed code redirects with reason=exchange_failed', async () => {
    const { state } = await begin();
    expect(await svc.handleCallback({ state })).toBe(errorUrl('exchange_failed'));
    expect(await svc.handleCallback({ code: 'a b', state })).toBe(errorUrl('exchange_failed'));
    expect(await svc.handleCallback({ code: 'x'.repeat(513), state })).toBe(errorUrl('exchange_failed'));
  });

  test('access_denied redirects with reason=access_denied and consumes the state', async () => {
    const { state } = await begin();
    expect(await svc.handleCallback({ error: 'access_denied', code: 'c', state })).toBe(errorUrl('access_denied'));
    expect(await redis.get(`aib:oauth:state:${state}`)).toBeNull();
    expect(transport.requests).toHaveLength(0);
    // The consumed state cannot be completed afterwards.
    expect(await svc.completeConnect('u1', { code: 'c', state })).toEqual({ ok: false, reason: 'invalid_state' });
    expect(repo.connections.size).toBe(0);
  });

  test('another OAuth error redirects with reason=exchange_failed; an error with an unknown state is invalid_state', async () => {
    const { state } = await begin();
    expect(await svc.handleCallback({ error: 'server_error', state })).toBe(errorUrl('exchange_failed'));
    expect(await svc.handleCallback({ error: 'access_denied', state })).toBe(errorUrl('invalid_state'));
  });

  test('redirects with reason=unavailable when the config is null', async () => {
    const prev = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'https://eksiegowyai.pl/';
    try {
      expect(await build({ config: null }).handleCallback({ code: 'c', state: 'AAAAAAAAAAAAAAAAAAAAAA' })).toBe(errorUrl('unavailable'));
    } finally {
      if (prev === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = prev;
    }
    expect(transport.requests).toHaveLength(0);
  });
});

describe('completeConnect', () => {
  test('exchanges the code, stores encrypted tokens, syncs accounts and starts the first sync', async () => {
    const { state, verifier } = await begin();
    transport.queue(TOKEN, 200, tokenBody());
    expect(await svc.completeConnect('u1', { code: 'c', state })).toEqual({ ok: true });
    expect(transport.requests[0].form).toMatchObject({
      grant_type: 'authorization_code', code: 'c', code_verifier: verifier, redirect_uri: config.redirectUri,
    });
    const conn = repo.connections.get('u1')!;
    expect(conn.status).toBe('active');
    expect(conn.accessTokenEnc).not.toContain('aba_at_');
    expect(conn.refreshTokenEnc).not.toContain('aba_rt_');
    expect(crypto.decryptFromString(conn.accessTokenEnc!)).toBe('aba_at_1');
    expect(accounts.syncAccountList).toHaveBeenCalledWith('u1');
    expect(sync.syncCompany).toHaveBeenCalledWith('u1', { fullResync: true });
  });

  test('a state is single-use (replay)', async () => {
    const { state } = await begin();
    transport.queue(TOKEN, 200, tokenBody());
    expect(await svc.completeConnect('u1', { code: 'c', state })).toEqual({ ok: true });
    expect(await svc.completeConnect('u1', { code: 'c', state })).toEqual({ ok: false, reason: 'invalid_state' });
    expect(transport.requests).toHaveLength(1);
  });

  test('the state is consumed with GETDEL', async () => {
    const { state } = await begin();
    const getDel = jest.spyOn(redis, 'getDel');
    const get = jest.spyOn(redis, 'get');
    transport.queue(TOKEN, 200, tokenBody());
    await svc.completeConnect('u1', { code: 'c', state });
    expect(getDel).toHaveBeenCalledWith(`aib:oauth:state:${state}`);
    expect(get).not.toHaveBeenCalledWith(`aib:oauth:state:${state}`);
  });

  test('an expired state stores nothing', async () => {
    const { state } = await begin();
    redis.advance(601_000);
    expect(await svc.completeConnect('u1', { code: 'c', state })).toEqual({ ok: false, reason: 'invalid_state' });
    expect(transport.requests).toHaveLength(0);
    expect(repo.connections.get('u1')).toBeUndefined();
    expect(accounts.syncAccountList).not.toHaveBeenCalled();
  });

  test('an unknown or malformed state stores nothing', async () => {
    await begin();
    for (const state of ['AAAAAAAAAAAAAAAAAAAAAA', '', '../../x', 'a'.repeat(500)]) {
      expect(await svc.completeConnect('u1', { code: 'c', state })).toEqual({ ok: false, reason: 'invalid_state' });
    }
    expect(transport.requests).toHaveLength(0);
    expect(repo.connections.size).toBe(0);
  });

  test('a state stored with a malformed payload is rejected', async () => {
    await redis.setEx('aib:oauth:state:AAAAAAAAAAAAAAAAAAAAAA', 600, 'not json');
    expect(await svc.completeConnect('u1', { code: 'c', state: 'AAAAAAAAAAAAAAAAAAAAAA' })).toEqual({ ok: false, reason: 'invalid_state' });
    await redis.setEx('aib:oauth:state:BBBBBBBBBBBBBBBBBBBBBB', 600, JSON.stringify({ userId: 'u1' }));
    expect(await svc.completeConnect('u1', { code: 'c', state: 'BBBBBBBBBBBBBBBBBBBBBB' })).toEqual({ ok: false, reason: 'invalid_state' });
    expect(transport.requests).toHaveLength(0);
  });

  test("another user's state is refused with state_mismatch: nothing stored, state consumed", async () => {
    const { state } = await begin('attacker');
    expect(await svc.completeConnect('victim', { code: 'c', state })).toEqual({ ok: false, reason: 'state_mismatch' });
    expect(transport.requests).toHaveLength(0);
    expect(repo.connections.size).toBe(0);
    expect(await redis.get(`aib:oauth:state:${state}`)).toBeNull();
    expect(await svc.completeConnect('attacker', { code: 'c', state })).toEqual({ ok: false, reason: 'invalid_state' });
  });

  test('a failed code exchange returns exchange_failed', async () => {
    const { state } = await begin();
    transport.queue(TOKEN, 400, { error: 'invalid_grant' });
    expect(await svc.completeConnect('u1', { code: 'c', state })).toEqual({ ok: false, reason: 'exchange_failed' });
    expect(repo.connections.size).toBe(0);
    expect(accounts.syncAccountList).not.toHaveBeenCalled();
    expect(sync.syncCompany).not.toHaveBeenCalled();
  });

  test('a network failure on the exchange returns exchange_failed', async () => {
    const { state } = await begin();
    expect(await svc.completeConnect('u1', { code: 'c', state })).toEqual({ ok: false, reason: 'exchange_failed' });
    expect(repo.connections.size).toBe(0);
  });

  test('a failed account sync still connects; the first sync still starts', async () => {
    const { state } = await begin();
    transport.queue(TOKEN, 200, tokenBody());
    accounts.syncAccountList.mockRejectedValue(new Error('boom'));
    expect(await svc.completeConnect('u1', { code: 'c', state })).toEqual({ ok: true });
    expect(sync.syncCompany).toHaveBeenCalledWith('u1', { fullResync: true });
  });

  test('a rejected first sync does not escape', async () => {
    const { state } = await begin();
    transport.queue(TOKEN, 200, tokenBody());
    sync.syncCompany.mockRejectedValue(new Error('boom'));
    expect(await svc.completeConnect('u1', { code: 'c', state })).toEqual({ ok: true });
    await new Promise((r) => setImmediate(r));
  });

  test('throws unavailable when the config is null', async () => {
    await expect(build({ config: null }).completeConnect('u1', { code: 'c', state: 'AAAAAAAAAAAAAAAAAAAAAA' }))
      .rejects.toBeInstanceOf(AiBudgetUnavailableError);
  });

  test('reconnect does not revoke the previous tokens', async () => {
    repo.seedConnection('u1', {
      accessTokenEnc: crypto.encryptToString('aba_at_old'), refreshTokenEnc: crypto.encryptToString('aba_rt_old'), status: 'needs_reconnect',
    });
    const { state } = await begin();
    transport.queue(TOKEN, 200, tokenBody(2));
    expect(await svc.completeConnect('u1', { code: 'c', state })).toEqual({ ok: true });
    expect(transport.requests.map((r) => r.url)).toEqual(['https://api.ai-budget.pl/oauth/token']);
    const conn = repo.connections.get('u1')!;
    expect(conn.status).toBe('active');
    expect(crypto.decryptFromString(conn.refreshTokenEnc!)).toBe('aba_rt_2');
  });

  test('reconnect after a disconnect reactivates the revoked connection', async () => {
    repo.seedConnection('u1', { status: 'revoked', accessTokenEnc: null, refreshTokenEnc: null });
    const { state } = await begin();
    transport.queue(TOKEN, 200, tokenBody(3));
    expect(await svc.completeConnect('u1', { code: 'c', state })).toEqual({ ok: true });
    expect(repo.connections.get('u1')!.status).toBe('active');
  });

  test('reconnect with a different set drops the former company and keeps manual labels of still-granted accounts', async () => {
    // Real accounts service over the fake transport: b1 (company, mirror + dismissal) is no longer granted;
    // b2 and p stay, p was manually labelled other_business.
    repo.seedConnection('u1', {
      accessTokenEnc: crypto.encryptToString('aba_at_old'), refreshTokenEnc: crypto.encryptToString('aba_rt_old'),
    });
    repo.seedAccount('u1', { externalId: 'b1', type: 'business', label: 'company', syncCursor: 'cur', lastSyncedAt: new Date() });
    repo.seedAccount('u1', { externalId: 'b2', type: 'business', label: 'other_business' });
    repo.seedAccount('u1', { externalId: 'p', type: 'personal', label: 'other_business', labelSource: 'manual' });
    repo.seedExpense('b1-row', 'e1');
    repo.seedDismissal('b1-row', 'e1');
    const api = new AiBudgetApiClient(config, transport, tokens);
    const realAccounts = new AiBudgetAccountsService(repo, api);
    svc = build({ accounts: realAccounts });

    const { state } = await begin();
    transport.queue(TOKEN, 200, tokenBody(2, ['b2', 'p']));
    transport.queue(ACCOUNTS, 200, { data: [remote('b2', 'business'), remote('p', 'personal')] });
    expect(await svc.completeConnect('u1', { code: 'c', state })).toEqual({ ok: true });

    expect(repo.accountRows.get('b1-row')).toBeUndefined();
    expect(repo.expenses('b1-row')).toHaveLength(0);
    expect(repo.dismissals('b1-row')).toHaveLength(0);
    expect(repo.accountRows.get('p-row')).toMatchObject({ label: 'other_business', labelSource: 'manual' });
    expect(repo.accountRows.get('b2-row')).toMatchObject({ label: 'company', labelSource: 'auto' });
    expect(transport.requests.some((r) => r.url.endsWith('/oauth/revoke'))).toBe(false);
    // The /accounts call went out with the new access token.
    expect(transport.requests.find((r) => r.url.endsWith('/public/v1/accounts'))!.headers!.Authorization).toBe('Bearer aba_at_2');
  });
});

describe('disconnect', () => {
  function seedConnected(): void {
    repo.seedConnection('u1', {
      accessTokenEnc: crypto.encryptToString('aba_at_1'), refreshTokenEnc: crypto.encryptToString('aba_rt_1'),
    });
    repo.seedAccount('u1', { externalId: 'b1', type: 'business', label: 'company', syncCursor: 'cur', lastSyncedAt: new Date() });
    repo.seedAccount('u1', { externalId: 'p', type: 'personal', label: 'other_business', labelSource: 'manual' });
    repo.seedExpense('b1-row', 'e1');
    repo.seedExpense('b1-row', 'e2');
    repo.seedDismissal('b1-row', 'e1');
  }

  test('revokes at AI Budget, then clears tokens, mirror and dismissals', async () => {
    seedConnected();
    await redis.setEx('aib:recon:u1', 300, 'cached');
    transport.queue(REVOKE, 200, {});
    expect(await svc.disconnect('u1')).toEqual({ revokedRemotely: true, remote: 'revoked' });
    const req = transport.requests.at(-1)!;
    expect(req.url).toBe('https://api.ai-budget.pl/oauth/revoke');
    expect(req.form).toMatchObject({ token: 'aba_rt_1', token_type_hint: 'refresh_token' });
    expect(repo.connections.get('u1')).toMatchObject({ accessTokenEnc: null, refreshTokenEnc: null, status: 'revoked' });
    expect(repo.expenses('b1-row')).toHaveLength(0);
    expect(repo.dismissals('b1-row')).toHaveLength(0);
    expect(repo.accountRows.get('b1-row')).toMatchObject({ syncCursor: null, lastSyncedAt: null });
    expect(await redis.get('aib:recon:u1')).toBeNull();
    // Account rows stay so manual labels survive a later reconnect.
    expect(repo.accountRows.get('p-row')).toMatchObject({ label: 'other_business', labelSource: 'manual' });
  });

  test('marks the connection revoked first, then revokes remotely, then clears mirrors, then tokens', async () => {
    seedConnected();
    const order: string[] = [];
    const realRequest = transport.request.bind(transport);
    jest.spyOn(transport, 'request').mockImplementation(async (r) => {
      order.push(`revoke(status=${repo.connections.get('u1')!.status})`);
      return realRequest(r);
    });
    const realStatus = repo.setConnectionStatus.bind(repo);
    jest.spyOn(repo, 'setConnectionStatus').mockImplementation(async (u, s, at) => { order.push(`status:${s}`); return realStatus(u, s, at); });
    for (const m of ['clearMirror', 'clearTokens'] as const) {
      const real = repo[m].bind(repo) as (x: string) => Promise<void>;
      jest.spyOn(repo, m).mockImplementation(async (x: string) => { order.push(m); return real(x); });
    }
    transport.queue(REVOKE, 200, {});
    await svc.disconnect('u1');
    expect(order).toEqual(['status:revoked', 'revoke(status=revoked)', 'clearMirror', 'clearMirror', 'clearTokens']);
    // The revoke still carried the refresh token, held in memory.
    expect(transport.requests[0].form).toMatchObject({ token: 'aba_rt_1' });
  });

  test('a sync whose page apply is held until after disconnect leaves no mirror rows', async () => {
    seedConnected();
    const api = new AiBudgetApiClient(config, transport, tokens);
    const realAccounts = new AiBudgetAccountsService(repo, api);
    const realSync = new AiBudgetMirrorSyncService(repo, realAccounts, api, redis);
    svc = build({ accounts: realAccounts, sync: realSync });

    const wire = (id: string) => ({
      id, amount: '10.00', currency: 'PLN', date: '2026-11-01', category_id: null, description: null, merchant: 'Bistro',
      category_splits: [], is_debt: false, is_split_receivable: false, updated_at: '2026-11-01T10:00:00Z', encrypted_fields: [],
    });
    transport.queue('GET /public/v1/expenses/changes', 200, {
      changes: [{ type: 'upsert', expense: wire('late1') }, { type: 'upsert', expense: wire('late2') }], next_cursor: 'n1', has_more: false,
    });
    let reached!: () => void;
    const applyReached = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realApply = repo.applyChangesPage.bind(repo);
    jest.spyOn(repo, 'applyChangesPage').mockImplementation(async (id, page) => { reached(); await gate; return realApply(id, page); });

    const running = realSync.syncCompany('u1');
    await applyReached;
    transport.queue(REVOKE, 200, {});
    expect(await svc.disconnect('u1')).toEqual({ revokedRemotely: true, remote: 'revoked' });
    release();
    expect(await running).toBe('aborted_relabelled');

    expect(repo.expenses('b1-row')).toHaveLength(0);
    expect(repo.connections.get('u1')).toMatchObject({ status: 'revoked', accessTokenEnc: null, refreshTokenEnc: null });
  });

  test('a refresh that fails with invalid_grant after disconnect leaves the connection revoked', async () => {
    seedConnected();
    repo.connections.set('u1', { ...repo.connections.get('u1')!, accessTokenExpiresAt: new Date(Date.now() + 10_000) });
    let reached!: () => void;
    const tokenReached = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realRequest = transport.request.bind(transport);
    jest.spyOn(transport, 'request').mockImplementation(async (r) => {
      if (r.url.endsWith('/oauth/token')) { reached(); await gate; }
      return realRequest(r);
    });
    transport.queue(TOKEN, 400, { error: 'invalid_grant' });
    transport.queue(REVOKE, 200, {});

    const refreshing = tokens.getAccessToken('u1');
    const outcome = refreshing.then(() => 'resolved', (e: Error) => e.name);
    await tokenReached;
    await svc.disconnect('u1');
    release();
    expect(await outcome).toBe('AiBudgetReconnectRequiredError');
    expect(repo.connections.get('u1')).toMatchObject({ status: 'revoked', accessTokenEnc: null, refreshTokenEnc: null });
  });

  test('a refresh that succeeds after disconnect does not bring tokens back', async () => {
    seedConnected();
    repo.connections.set('u1', { ...repo.connections.get('u1')!, accessTokenExpiresAt: new Date(Date.now() + 10_000) });
    let reached!: () => void;
    const tokenReached = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realRequest = transport.request.bind(transport);
    jest.spyOn(transport, 'request').mockImplementation(async (r) => {
      if (r.url.endsWith('/oauth/token')) { reached(); await gate; }
      return realRequest(r);
    });
    transport.queue(TOKEN, 200, tokenBody(9));
    transport.queue(REVOKE, 200, {});

    const refreshing = tokens.getAccessToken('u1').catch(() => undefined);
    await tokenReached;
    await svc.disconnect('u1');
    release();
    await refreshing;
    expect(repo.connections.get('u1')).toMatchObject({ status: 'revoked', accessTokenEnc: null, refreshTokenEnc: null });
  });

  test('a needs_reconnect connection whose revoke fails reports an expired grant, not a revoke failure', async () => {
    seedConnected();
    await repo.setConnectionStatus('u1', 'needs_reconnect', new Date());
    transport.queue(REVOKE, 400, { error: 'invalid_grant' });
    expect(await svc.disconnect('u1')).toEqual({ revokedRemotely: false, remote: 'expired' });
    expect(repo.connections.get('u1')).toMatchObject({ status: 'revoked', refreshTokenEnc: null });
  });

  test('a needs_reconnect connection whose revoke succeeds reports revoked', async () => {
    seedConnected();
    await repo.setConnectionStatus('u1', 'needs_reconnect', new Date());
    transport.queue(REVOKE, 200, {});
    expect(await svc.disconnect('u1')).toEqual({ revokedRemotely: true, remote: 'revoked' });
  });

  test('still clears locally when revoke fails and reports revokedRemotely:false', async () => {
    seedConnected();
    transport.queue(REVOKE, 503, {});
    expect(await svc.disconnect('u1')).toEqual({ revokedRemotely: false, remote: 'failed' });
    expect(repo.connections.get('u1')).toMatchObject({ accessTokenEnc: null, refreshTokenEnc: null, status: 'revoked' });
    expect(repo.expenses('b1-row')).toHaveLength(0);
    expect(repo.dismissals('b1-row')).toHaveLength(0);
  });

  test('a network failure on revoke is tolerated the same way', async () => {
    seedConnected();
    expect(await svc.disconnect('u1')).toEqual({ revokedRemotely: false, remote: 'failed' });
    expect(repo.connections.get('u1')!.status).toBe('revoked');
  });

  test('without stored tokens nothing is sent and the local data is still cleared', async () => {
    seedConnected();
    await repo.clearTokens('u1');
    expect(await svc.disconnect('u1')).toEqual({ revokedRemotely: false, remote: 'none' });
    expect(transport.requests).toHaveLength(0);
    expect(repo.expenses('b1-row')).toHaveLength(0);
  });

  test('throws unavailable when the config is null', async () => {
    await expect(build({ config: null }).disconnect('u1')).rejects.toBeInstanceOf(AiBudgetUnavailableError);
  });
});

describe('getStatus', () => {
  test('is unavailable when config is null', async () => {
    expect(await build({ config: null }).getStatus('u1')).toEqual({ available: false, connection: null });
  });

  test('no connection and a revoked connection both map to connection:null', async () => {
    expect(await svc.getStatus('u1')).toEqual({ available: true, connection: null });
    repo.seedConnection('u1', { status: 'revoked', accessTokenEnc: null, refreshTokenEnc: null });
    repo.seedAccount('u1', { externalId: 'b1', type: 'business', label: 'company' });
    expect(await svc.getStatus('u1')).toEqual({ available: true, connection: null });
    expect(accounts.syncAccountList).not.toHaveBeenCalled();
  });

  test('an active connection re-syncs the account list and returns the accounts without tokens or sync internals', async () => {
    const synced = new Date('2026-11-02T10:00:00Z');
    repo.seedConnection('u1', { needsCompanyChoice: false });
    repo.seedAccount('u1', { externalId: 'b1', type: 'business', label: 'company', syncCursor: 'secret-cursor', lastSyncedAt: synced, lastSyncError: 'rate_limited' });
    repo.seedAccount('u1', { externalId: 'p', type: 'personal', label: 'private', active: false, inactiveReason: 'archived' });
    const status = await svc.getStatus('u1');
    expect(accounts.syncAccountList).toHaveBeenCalledWith('u1');
    expect(status).toEqual({
      available: true,
      connection: {
        status: 'active', lastSyncedAt: synced.toISOString(), lastSyncError: 'rate_limited', needsCompanyChoice: false,
        accounts: [
          { id: 'b1-row', externalId: 'b1', name: 'b1', type: 'business', currency: 'PLN', access: 'read', active: true, inactiveReason: null, label: 'company', labelSource: 'auto' },
          { id: 'p-row', externalId: 'p', name: 'p', type: 'personal', currency: 'PLN', access: 'read', active: false, inactiveReason: 'archived', label: 'private', labelSource: 'auto' },
        ],
      },
    });
    expect(JSON.stringify(status)).not.toContain('secret-cursor');
    expect(JSON.stringify(status)).not.toMatch(/accessToken|refreshToken|syncCursor/);
  });

  test('a failed account re-sync is swallowed and the stored rows are returned', async () => {
    repo.seedConnection('u1', { needsCompanyChoice: true });
    repo.seedAccount('u1', { externalId: 'b1', type: 'business', label: 'other_business' });
    accounts.syncAccountList.mockRejectedValue(new Error('boom'));
    const status = await svc.getStatus('u1');
    expect(status.connection).toMatchObject({ status: 'active', needsCompanyChoice: true, lastSyncedAt: null, lastSyncError: null });
    expect(status.connection!.accounts.map((a) => a.externalId)).toEqual(['b1']);
  });

  test('needs_reconnect does not call AI Budget and reports the status', async () => {
    repo.seedConnection('u1', { status: 'needs_reconnect' });
    repo.seedAccount('u1', { externalId: 'b1', type: 'business', label: 'company', lastSyncedAt: new Date() });
    const status = await svc.getStatus('u1');
    expect(accounts.syncAccountList).not.toHaveBeenCalled();
    expect(status.connection!.status).toBe('needs_reconnect');
  });

  test('a re-sync that discovers a lost connection reports needs_reconnect', async () => {
    repo.seedConnection('u1');
    accounts.syncAccountList.mockImplementation(async () => { await repo.setConnectionStatus('u1', 'needs_reconnect', new Date()); throw new Error('x'); });
    expect((await svc.getStatus('u1')).connection!.status).toBe('needs_reconnect');
  });
});

describe('disconnect and the live-read cache', () => {
  test('disconnect invalidates the live cache of every account', async () => {
    repo.seedConnection('u1', {
      accessTokenEnc: crypto.encryptToString('aba_at_1'), refreshTokenEnc: crypto.encryptToString('aba_rt_1'),
    });
    repo.seedAccount('u1', { externalId: 'b1', type: 'business', label: 'company' });
    repo.seedAccount('u1', { externalId: 'p1' });
    transport.queue(REVOKE, 200, {});
    const invalidate = jest.fn().mockResolvedValue(undefined);
    const oauth = new AiBudgetOAuthClient(config, transport);
    const s = new AiBudgetOAuthService(config, {
      redis, oauth, tokens, crypto, repo, accounts: accounts as unknown as AiBudgetAccountsService,
      sync: sync as unknown as AiBudgetMirrorSyncService, live: { invalidate },
    });
    await s.disconnect('u1');
    expect(invalidate).toHaveBeenCalledWith('u1', 'b1-row');
    expect(invalidate).toHaveBeenCalledWith('u1', 'p1-row');
  });
});
