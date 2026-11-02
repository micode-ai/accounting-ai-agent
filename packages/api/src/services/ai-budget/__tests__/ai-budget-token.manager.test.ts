import { CryptoService } from '../../crypto.service';
import { AiBudgetConfig } from '../ai-budget.config';
import { AiBudgetOAuthClient } from '../ai-budget-oauth.client';
import { AiBudgetTokenManager, ConnectionRow, StoredTokens, TokenStore } from '../ai-budget-token.manager';
import { AiBudgetApiError, AiBudgetNotConnectedError, AiBudgetReconnectRequiredError } from '../ai-budget-errors';
import { FakeRedis, FakeTransport } from './fakes';
import { logger } from '../../../utils/logger';

process.env.CREDENTIALS_ENCRYPTION_KEY = 'a'.repeat(64);

const NOW = new Date('2026-11-02T12:00:00Z');
const config: AiBudgetConfig = {
  clientId: 'cid', clientSecret: 'csecret', apiUrl: 'https://api.ai-budget.pl', authorizeUrl: 'https://app.ai-budget.pl/authorize',
  tokenUrl: 'https://api.ai-budget.pl/oauth/token', revokeUrl: 'https://api.ai-budget.pl/oauth/revoke',
  redirectUri: 'https://api.eksiegowyai.pl/api/integrations/ai-budget/callback', frontendUrl: 'https://eksiegowyai.pl',
};

class MemoryStore implements TokenStore {
  conn: ConnectionRow | null = null;
  async getConnection(userId: string) { return this.conn && this.conn.userId === userId ? { ...this.conn } : null; }
  async upsertConnectionTokens(userId: string, t: StoredTokens) {
    this.conn = { id: this.conn?.id ?? 'c1', userId, ...t, status: 'active', statusChangedAt: NOW, needsCompanyChoice: this.conn?.needsCompanyChoice ?? false };
    return { ...this.conn };
  }
  async updateTokens(connectionId: string, previousRefreshTokenEnc: string, t: StoredTokens) {
    if (this.conn?.id !== connectionId || this.conn.status === 'revoked' || this.conn.refreshTokenEnc !== previousRefreshTokenEnc) return false;
    this.conn = { ...this.conn, ...t };
    return true;
  }
  async setConnectionStatus(userId: string, status: ConnectionRow['status'], at: Date) {
    if (this.conn?.userId === userId) this.conn = { ...this.conn, status, statusChangedAt: at };
  }
}

let crypto: CryptoService; let store: MemoryStore; let redis: FakeRedis; let transport: FakeTransport; let m: AiBudgetTokenManager;

function conn(access: string, refresh: string, expiresInMs: number): ConnectionRow {
  return { id: 'c1', userId: 'u1', accessTokenEnc: crypto.encryptToString(access), refreshTokenEnc: crypto.encryptToString(refresh),
    accessTokenExpiresAt: new Date(NOW.getTime() + expiresInMs), scope: 'expenses:read', status: 'active', statusChangedAt: NOW, needsCompanyChoice: false };
}
const rotatedBody = { access_token: 'aba_at_2', refresh_token: 'aba_rt_2', expires_in: 3600, scope: 'expenses:read', account_ids: ['acc-1'] };

beforeEach(() => {
  crypto = new CryptoService(); store = new MemoryStore(); redis = new FakeRedis(); transport = new FakeTransport();
  m = new AiBudgetTokenManager(store, crypto, redis, new AiBudgetOAuthClient(config, transport), { now: () => NOW, pollMs: 10, waitMs: 1000 });
  store.conn = conn('aba_at_1', 'aba_rt_1', 30_000);
});

test('returns the stored access token while more than 60 s remain', async () => {
  store.conn = conn('aba_at_1', 'aba_rt_1', 120_000);
  expect(await m.getAccessToken('u1')).toBe('aba_at_1');
  expect(transport.requests).toHaveLength(0);
});

test('refreshes under the lock and saves the rotated pair before returning', async () => {
  transport.queue('POST /oauth/token', 200, rotatedBody);
  expect(await m.getAccessToken('u1')).toBe('aba_at_2');
  expect(crypto.decryptFromString(store.conn!.refreshTokenEnc!)).toBe('aba_rt_2');
  expect(crypto.decryptFromString(store.conn!.accessTokenEnc!)).toBe('aba_at_2');
  expect(store.conn!.accessTokenExpiresAt).toEqual(new Date(NOW.getTime() + 3600_000));
  expect(transport.requests[0].form).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'aba_rt_1' });
  expect(transport.requests[0].headers!.Authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
  expect(await redis.get('aib:refresh:u1')).toBeNull();
});

test('two concurrent callers produce exactly one refresh', async () => {
  transport.queue('POST /oauth/token', 200, rotatedBody);
  const [a, b] = await Promise.all([m.getAccessToken('u1'), m.getAccessToken('u1')]);
  expect(a).toBe('aba_at_2'); expect(b).toBe('aba_at_2');
  expect(transport.requests.filter((r) => r.url.endsWith('/oauth/token'))).toHaveLength(1);
});

test('a caller that finds the lock held waits, re-reads the store and does not refresh', async () => {
  await redis.setNxPx('aib:refresh:u1', 'other-process', 30000);
  const rotated = conn('aba_at_9', 'aba_rt_9', 3600_000);
  setTimeout(() => { store.conn = rotated; void redis.del('aib:refresh:u1'); }, 50);
  expect(await m.getAccessToken('u1')).toBe('aba_at_9');
  expect(transport.requests).toHaveLength(0);
});

test('a waiter whose wait runs out with the token still stale takes the lock itself once it is free', async () => {
  m = new AiBudgetTokenManager(store, crypto, redis, new AiBudgetOAuthClient(config, transport), { now: () => NOW, pollMs: 10, waitMs: 30 });
  await redis.setNxPx('aib:refresh:u1', 'other-process', 30000);
  setTimeout(() => { void redis.del('aib:refresh:u1'); }, 60);
  transport.queue('POST /oauth/token', 200, rotatedBody);
  await expect(m.getAccessToken('u1')).rejects.toMatchObject({ code: 'refresh_in_progress' });
  expect(transport.requests).toHaveLength(0);
  await new Promise((r) => setTimeout(r, 80));
  expect(await m.getAccessToken('u1')).toBe('aba_at_2');
});

test('does not release a lock that another process now holds', async () => {
  transport.queue('POST /oauth/token', 200, rotatedBody);
  const orig = transport.request.bind(transport);
  transport.request = async (req) => { redis.advance(31_000); await redis.setNxPx('aib:refresh:u1', 'someone-else', 30000); return orig(req); };
  await m.getAccessToken('u1');
  expect(await redis.get('aib:refresh:u1')).toBe('someone-else');
});

test('invalid_grant marks needs_reconnect and throws AiBudgetReconnectRequiredError', async () => {
  transport.queue('POST /oauth/token', 400, { error: 'invalid_grant', error_description: 'x' });
  await expect(m.getAccessToken('u1')).rejects.toBeInstanceOf(AiBudgetReconnectRequiredError);
  expect(store.conn!.status).toBe('needs_reconnect');
  expect(await redis.get('aib:refresh:u1')).toBeNull();
});

test('a 503 on refresh keeps the connection active', async () => {
  transport.queue('POST /oauth/token', 503, { error: 'temporarily_unavailable' });
  await expect(m.getAccessToken('u1')).rejects.toMatchObject({ status: 503, code: 'temporarily_unavailable' });
  expect(store.conn!.status).toBe('active');
  expect(crypto.decryptFromString(store.conn!.refreshTokenEnc!)).toBe('aba_rt_1');
});

test('no connection or revoked connection throws AiBudgetNotConnectedError', async () => {
  store.conn = null;
  await expect(m.getAccessToken('u1')).rejects.toBeInstanceOf(AiBudgetNotConnectedError);
  store.conn = { ...conn('aba_at_1', 'aba_rt_1', 120_000), status: 'revoked' };
  await expect(m.getAccessToken('u1')).rejects.toBeInstanceOf(AiBudgetNotConnectedError);
  store.conn = { ...conn('aba_at_1', 'aba_rt_1', 120_000), accessTokenEnc: null, refreshTokenEnc: null };
  await expect(m.getAccessToken('u1')).rejects.toBeInstanceOf(AiBudgetNotConnectedError);
});

test('a needs_reconnect connection throws AiBudgetReconnectRequiredError without calling AI Budget', async () => {
  store.conn = { ...conn('aba_at_1', 'aba_rt_1', 120_000), status: 'needs_reconnect' };
  await expect(m.getAccessToken('u1')).rejects.toBeInstanceOf(AiBudgetReconnectRequiredError);
  expect(transport.requests).toHaveLength(0);
});

test('forceRefresh refreshes only while the stored token equals the stale one', async () => {
  store.conn = conn('aba_at_1', 'aba_rt_1', 3600_000);
  transport.queue('POST /oauth/token', 200, rotatedBody);
  expect(await m.forceRefresh('u1', 'aba_at_1')).toBe('aba_at_2');
  expect(await m.forceRefresh('u1', 'aba_at_1')).toBe('aba_at_2');
  expect(transport.requests).toHaveLength(1);
});

test('a refresh reports the authoritative account_ids to the listener after saving', async () => {
  const seen: Array<[string, string[], string]> = [];
  m.setAccountIdsListener(async (userId, ids) => { seen.push([userId, ids, crypto.decryptFromString(store.conn!.accessTokenEnc!)]); });
  transport.queue('POST /oauth/token', 200, { ...rotatedBody, account_ids: ['acc-2'] });
  await m.getAccessToken('u1');
  expect(seen).toEqual([['u1', ['acc-2'], 'aba_at_2']]);
});

test('saveInitialTokens stores the pair encrypted and marks the connection active', async () => {
  store.conn = null;
  await m.saveInitialTokens('u1', rotatedBody);
  expect(store.conn!.accessTokenEnc).not.toContain('aba_at_');
  expect(crypto.decryptFromString(store.conn!.accessTokenEnc!)).toBe('aba_at_2');
  expect(store.conn!.status).toBe('active');
});

describe('a refresh whose tokens cannot be saved', () => {
  beforeEach(() => {
    m = new AiBudgetTokenManager(store, crypto, redis, new AiBudgetOAuthClient(config, transport), { now: () => NOW, pollMs: 10, waitMs: 1000, saveRetryDelayMs: 1 });
  });

  test('a failed save is retried under the lock and the pair is saved after one refresh', async () => {
    const orig = store.updateTokens.bind(store);
    let calls = 0;
    store.updateTokens = async (id, prev, t) => { calls++; if (calls === 1) throw new Error('db down'); return orig(id, prev, t); };
    transport.queue('POST /oauth/token', 200, rotatedBody);
    expect(await m.getAccessToken('u1')).toBe('aba_at_2');
    expect(calls).toBe(2);
    expect(crypto.decryptFromString(store.conn!.refreshTokenEnc!)).toBe('aba_rt_2');
    expect(transport.requests).toHaveLength(1);
  });

  test('a save that keeps failing marks needs_reconnect so the spent refresh token is never presented again', async () => {
    store.updateTokens = async () => { throw new Error('db down'); };
    transport.queue('POST /oauth/token', 200, rotatedBody);
    await expect(m.getAccessToken('u1')).rejects.toMatchObject({ status: 500, code: 'token_save_failed' });
    expect(store.conn!.status).toBe('needs_reconnect');
    expect(await redis.get('aib:refresh:u1')).toBeNull();
    await expect(m.getAccessToken('u1')).rejects.toBeInstanceOf(AiBudgetReconnectRequiredError);
    expect(transport.requests).toHaveLength(1);
  });
});

describe('a refresh with an unknown outcome', () => {
  function failNextWith(err: Error): void {
    const orig = transport.request.bind(transport);
    let used = false;
    transport.request = async (req) => {
      if (!used) { used = true; transport.requests.push(req); throw err; }
      return orig(req);
    };
  }

  test('blocks further refreshes with refresh_in_progress until the marker expires', async () => {
    failNextWith(new AiBudgetApiError(0, 'timeout'));
    await expect(m.getAccessToken('u1')).rejects.toMatchObject({ status: 0, code: 'timeout' });
    await expect(m.getAccessToken('u1')).rejects.toMatchObject({ status: 503, code: 'refresh_in_progress' });
    await expect(m.forceRefresh('u1', 'aba_at_1')).rejects.toMatchObject({ code: 'refresh_in_progress' });
    expect(transport.requests).toHaveLength(1);
    expect(store.conn!.status).toBe('active');
    expect(await redis.get('aib:refresh:u1')).toBeNull();

    redis.advance(61_000);
    transport.queue('POST /oauth/token', 400, { error: 'invalid_grant' });
    await expect(m.getAccessToken('u1')).rejects.toBeInstanceOf(AiBudgetReconnectRequiredError);
    expect(transport.requests).toHaveLength(2);
    expect(store.conn!.status).toBe('needs_reconnect');
  });

  test('after the marker expires one refresh is attempted and may succeed', async () => {
    failNextWith(new AiBudgetApiError(0, 'network_error'));
    await expect(m.getAccessToken('u1')).rejects.toMatchObject({ code: 'network_error' });
    redis.advance(61_000);
    transport.queue('POST /oauth/token', 200, rotatedBody);
    expect(await m.getAccessToken('u1')).toBe('aba_at_2');
    expect(transport.requests).toHaveLength(2);
  });

  test('a 200 with an unreadable body is treated as an unknown outcome', async () => {
    transport.queue('POST /oauth/token', 200, { access_token: 'aba_at_2' });
    await expect(m.getAccessToken('u1')).rejects.toMatchObject({ code: 'invalid_token_response' });
    await expect(m.getAccessToken('u1')).rejects.toMatchObject({ code: 'refresh_in_progress' });
    expect(transport.requests).toHaveLength(1);
  });

  test('a known failure (4xx other than invalid_grant) sets no marker', async () => {
    transport.queue('POST /oauth/token', 400, { error: 'invalid_request' });
    transport.queue('POST /oauth/token', 200, rotatedBody);
    await expect(m.getAccessToken('u1')).rejects.toMatchObject({ status: 400 });
    expect(await m.getAccessToken('u1')).toBe('aba_at_2');
  });

  test.each([500, 502, 503, 504])('a %i from /oauth/token is an unknown outcome and blocks the next refresh', async (status) => {
    transport.queue('POST /oauth/token', status, { error: 'server_error' });
    await expect(m.getAccessToken('u1')).rejects.toMatchObject({ status });
    await expect(m.getAccessToken('u1')).rejects.toMatchObject({ code: 'refresh_in_progress' });
    expect(transport.requests).toHaveLength(1);
    expect(store.conn!.status).toBe('active');
  });

  test('a Redis error while setting the marker does not mask the refresh error', async () => {
    redis.setEx = async () => { throw new Error('redis down'); };
    failNextWith(new AiBudgetApiError(0, 'timeout'));
    await expect(m.getAccessToken('u1')).rejects.toMatchObject({ status: 0, code: 'timeout' });
  });
});

test('a failed save attempt is logged with a code only, never the error message', async () => {
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  m = new AiBudgetTokenManager(store, crypto, redis, new AiBudgetOAuthClient(config, transport), { now: () => NOW, pollMs: 10, waitMs: 1000, saveRetryDelayMs: 1 });
  const orig = store.updateTokens.bind(store);
  let calls = 0;
  store.updateTokens = async (id, prev, t) => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('secret aba_rt_2 in message'), { code: 'P2024' });
    return orig(id, prev, t);
  };
  transport.queue('POST /oauth/token', 200, rotatedBody);
  expect(await m.getAccessToken('u1')).toBe('aba_at_2');
  const call = warn.mock.calls.find((c) => String(c[0]).includes('save attempt failed'));
  expect((call as unknown[] | undefined)?.[1]).toEqual({ userId: 'u1', attempt: 1, code: 'P2024' });
  expect(JSON.stringify(warn.mock.calls)).not.toContain('aba_rt_2');
  warn.mockRestore();
});

test('a rotated pair superseded by a newer save (reconnect) is dropped without failing the connection', async () => {
  const seen: string[][] = [];
  m.setAccountIdsListener(async (_u, ids) => { seen.push(ids); });
  const orig = transport.request.bind(transport);
  transport.request = async (req) => {
    // A reconnect saved a new grant while the old grant's refresh was in flight.
    store.conn = { ...conn('aba_at_new', 'aba_rt_new', 3600_000) };
    return orig(req);
  };
  transport.queue('POST /oauth/token', 200, rotatedBody);
  expect(await m.getAccessToken('u1')).toBe('aba_at_new');
  expect(crypto.decryptFromString(store.conn!.refreshTokenEnc!)).toBe('aba_rt_new');
  expect(store.conn!.status).toBe('active');
  expect(seen).toEqual([]);
});

test('saveInitialTokens waits for an in-flight refresh to release the lock before saving', async () => {
  store.conn = null;
  await redis.setNxPx('aib:refresh:u1', 'refresher', 30000);
  let releasedAt = 0;
  setTimeout(() => { releasedAt = Date.now(); void redis.del('aib:refresh:u1'); }, 60);
  const spy = jest.spyOn(store, 'upsertConnectionTokens');
  await m.saveInitialTokens('u1', rotatedBody);
  expect(releasedAt).toBeGreaterThan(0);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(await redis.get('aib:refresh:u1')).toBeNull();
  expect(crypto.decryptFromString(store.conn!.accessTokenEnc!)).toBe('aba_at_2');
});

test('saveInitialTokens clears a stale unknown-outcome marker of the old grant', async () => {
  await redis.setEx('aib:refresh-unknown:u1', 60, '1');
  await m.saveInitialTokens('u1', rotatedBody);
  expect(await redis.get('aib:refresh-unknown:u1')).toBeNull();
});
