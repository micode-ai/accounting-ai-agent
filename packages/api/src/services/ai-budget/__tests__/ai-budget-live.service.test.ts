import { CryptoService } from '../../crypto.service';
import type { AiBudgetConfig } from '../ai-budget.config';
import { AiBudgetApiClient } from '../ai-budget-api.client';
import { AiBudgetLiveReadService, LIVE_CACHE_TTL_SECONDS } from '../ai-budget-live.service';
import type { AiBudgetTokenManager } from '../ai-budget-token.manager';
import { logger } from '../../../utils/logger';
import { FakeRedis, FakeTransport } from './fakes';

process.env.CREDENTIALS_ENCRYPTION_KEY = 'a'.repeat(64);

const config: AiBudgetConfig = {
  clientId: 'cid', clientSecret: 'csecret', apiUrl: 'https://api.ai-budget.pl', authorizeUrl: 'https://app.ai-budget.pl/authorize',
  tokenUrl: 'https://api.ai-budget.pl/oauth/token', revokeUrl: 'https://api.ai-budget.pl/oauth/revoke',
  redirectUri: 'https://api.eksiegowyai.pl/api/integrations/ai-budget/callback', frontendUrl: 'https://eksiegowyai.pl',
};

class SpyRedis extends FakeRedis {
  readonly sets: Array<[string, number, string]> = [];
  override async setEx(key: string, seconds: number, value: string): Promise<'OK'> {
    this.sets.push([key, seconds, value]);
    return super.setEx(key, seconds, value);
  }
  lastSetEx(): [string, number, string] { return this.sets[this.sets.length - 1]; }
}

const EXPENSES = 'GET /public/v1/expenses';
const wire = (id: string, merchant = 'Biedronka') => ({
  id, amount: '42.50', currency: 'PLN', date: '2026-11-01', category_id: null, description: null, merchant,
  category_splits: [], is_debt: false, is_split_receivable: false, updated_at: '2026-11-01T10:00:00Z', encrypted_fields: [],
});
const page = (ids: string[], hasMore = false) => ({ data: ids.map((i) => wire(i)), next_cursor: hasMore ? 'cur' : null, has_more: hasMore });
const acc = { id: 'acc-row', externalId: 'acc-ext' };
const f = { dateFrom: '2026-11-01', dateTo: '2026-11-30' };

let crypto: CryptoService;
let redis: SpyRedis;
let transport: FakeTransport;
let live: AiBudgetLiveReadService;

beforeEach(() => {
  crypto = new CryptoService();
  redis = new SpyRedis();
  transport = new FakeTransport();
  const tokens = { getAccessToken: jest.fn().mockResolvedValue('aba_at_1'), forceRefresh: jest.fn() };
  const api = new AiBudgetApiClient(config, transport, tokens as unknown as AiBudgetTokenManager);
  live = new AiBudgetLiveReadService(api, redis, crypto);
});

test('second identical read within 5 minutes hits the cache', async () => {
  transport.queue(EXPENSES, 200, page(['e1']));
  const a = await live.listExpenses('u1', acc, f);
  const b = await live.listExpenses('u1', acc, f);
  expect(transport.requests).toHaveLength(1);
  expect(b).toEqual(a);
  expect(transport.requests[0].headers).toMatchObject({ 'X-Account-Id': 'acc-ext' });
});

test('cached values are ciphertext, never plaintext, with a 300 s TTL', async () => {
  transport.queue(EXPENSES, 200, page(['e1']));
  await live.listExpenses('u1', acc, f);
  const [key, ttl, value] = redis.lastSetEx();
  expect(key).toMatch(/^aib:live:u1:acc-row:\d+:[0-9a-f]{64}$/);
  expect(ttl).toBe(LIVE_CACHE_TTL_SECONDS);
  expect(ttl).toBe(300);
  expect(value).not.toContain('Biedronka');
  expect(crypto.decryptFromString(value)).toContain('Biedronka');
});

test('the cache expires after 300 s', async () => {
  transport.queue(EXPENSES, 200, page(['e1'])).queue(EXPENSES, 200, page(['e1']));
  await live.listExpenses('u1', acc, f);
  redis.advance(301_000);
  await live.listExpenses('u1', acc, f);
  expect(transport.requests).toHaveLength(2);
});

test('different filters do not share a cache entry', async () => {
  transport.queue(EXPENSES, 200, page(['e1'])).queue(EXPENSES, 200, page(['e2']));
  await live.listExpenses('u1', acc, f);
  await live.listExpenses('u1', acc, { ...f, dateTo: '2026-11-15' });
  expect(transport.requests).toHaveLength(2);
});

test('invalidate makes the next read go to AI Budget', async () => {
  transport.queue(EXPENSES, 200, page(['e1'])).queue(EXPENSES, 200, page(['e1']));
  await live.listExpenses('u1', acc, f);
  await live.invalidate('u1', 'acc-row');
  await live.listExpenses('u1', acc, f);
  expect(transport.requests).toHaveLength(2);
});

test('a cache entry that fails to decrypt is treated as a miss and replaced', async () => {
  transport.queue(EXPENSES, 200, page(['e1'])).queue(EXPENSES, 200, page(['e1']));
  await live.listExpenses('u1', acc, f);
  const [key] = redis.lastSetEx();
  await redis.setEx(key, 300, 'not-a-valid-ciphertext');
  const res = await live.listExpenses('u1', acc, f);
  expect(transport.requests).toHaveLength(2);
  expect(res.expenses).toHaveLength(1);
  await live.listExpenses('u1', acc, f);
  expect(transport.requests).toHaveLength(2);
});

test('pages are followed up to 10 and then truncated:true', async () => {
  for (let i = 0; i < 11; i++) transport.queue(EXPENSES, 200, page([`e${i}`], true));
  const res = await live.listExpenses('u1', acc, f);
  expect(transport.requests).toHaveLength(10);
  expect(res.truncated).toBe(true);
  expect(res.expenses).toHaveLength(10);
  expect(transport.requests[1].query).toMatchObject({ cursor: 'cur', limit: 200 });
});

test('fewer pages than the cap is not truncated', async () => {
  transport.queue(EXPENSES, 200, page(['a'], true)).queue(EXPENSES, 200, page(['b']));
  const res = await live.listExpenses('u1', acc, f);
  expect(res.truncated).toBe(false);
  expect(res.expenses).toHaveLength(2);
});

test('categories are cached too', async () => {
  transport.queue('GET /public/v1/categories', 200, { data: [{ id: 'c1', name: 'Food', type: 'expense' }] });
  await live.listCategories('u1', acc);
  expect(await live.listCategories('u1', acc)).toEqual([{ id: 'c1', name: 'Food', type: 'expense' }]);
  expect(transport.requests).toHaveLength(1);
});

test('a failed read is not cached', async () => {
  transport.queue(EXPENSES, 500, {}).queue(EXPENSES, 200, page(['e1']));
  await expect(live.listExpenses('u1', acc, f)).rejects.toMatchObject({ status: 500 });
  expect(redis.sets).toHaveLength(0);
  await live.listExpenses('u1', acc, f);
  expect(transport.requests).toHaveLength(2);
});

test('nothing from the expense payload reaches the logger', async () => {
  const spies = (['info', 'debug', 'warn', 'error'] as const).map((l) => jest.spyOn(logger, l));
  transport.queue(EXPENSES, 200, page(['e1']));
  await live.listExpenses('u1', acc, f);
  await live.listExpenses('u1', acc, f);
  for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toMatch(/Biedronka|42\.50/);
});
