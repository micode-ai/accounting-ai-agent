import { AiBudgetAccountsService } from '../ai-budget-accounts.service';
import { AiBudgetApiClient } from '../ai-budget-api.client';
import { AiBudgetReconnectRequiredError } from '../ai-budget-errors';
import type { AccountRow } from '../ai-budget.repository';
import type { AiBudgetConfig } from '../ai-budget.config';
import type { AiBudgetTokenManager } from '../ai-budget-token.manager';
import { AiBudgetMirrorSyncService, FULL_RESYNC_INTERVAL_MS, toMirrorInput } from '../ai-budget-sync.service';
import type { PublicExpenseWire } from '../ai-budget.types';
import { AiBudgetDashboardService } from '../ai-budget-dashboard.service';
import { FakeRedis, FakeTransport, InMemoryAiBudgetRepository } from './fakes';

const config: AiBudgetConfig = {
  clientId: 'cid', clientSecret: 'csecret', apiUrl: 'https://api.ai-budget.pl', authorizeUrl: 'https://app.ai-budget.pl/authorize',
  tokenUrl: 'https://api.ai-budget.pl/oauth/token', revokeUrl: 'https://api.ai-budget.pl/oauth/revoke',
  redirectUri: 'https://api.eksiegowyai.pl/api/integrations/ai-budget/callback', frontendUrl: 'https://eksiegowyai.pl',
};
const CHANGES = 'GET /public/v1/expenses/changes';
const NOW = new Date('2026-11-02T12:00:00Z');
const DAY = 86400_000;

const wire = (id: string, amount = '10.00'): PublicExpenseWire => ({
  id, amount, currency: 'PLN', date: '2026-11-01', category_id: null, description: null, merchant: 'Bistro',
  category_splits: [], is_debt: false, is_split_receivable: false, updated_at: '2026-11-01T10:00:00Z', encrypted_fields: [],
});
const up = (id: string, amount?: string) => ({ type: 'upsert' as const, expense: wire(id, amount) });

let repo: InMemoryAiBudgetRepository;
let transport: FakeTransport;
let redis: FakeRedis;
let tokens: { getAccessToken: jest.Mock; forceRefresh: jest.Mock };
let sync: AiBudgetMirrorSyncService;
const account = () => repo.accountRows.get('b1-row')!;
const seedCompany = (over: Partial<AccountRow> = {}) =>
  repo.seedAccount('u1', { externalId: 'b1', type: 'business', label: 'company', ...over });

beforeEach(() => {
  repo = new InMemoryAiBudgetRepository();
  repo.seedConnection('u1');
  seedCompany();
  transport = new FakeTransport();
  redis = new FakeRedis();
  tokens = { getAccessToken: jest.fn().mockResolvedValue('at'), forceRefresh: jest.fn() };
  const api = new AiBudgetApiClient(config, transport, tokens as unknown as AiBudgetTokenManager);
  sync = new AiBudgetMirrorSyncService(repo, new AiBudgetAccountsService(repo, api), api, redis, () => NOW);
});

/** Relabels b1 to private (clearing its mirror) right after the n-th HTTP response, as the user would mid-sync. */
function relabelAfterResponse(n: number): void {
  const real = transport.request.bind(transport);
  jest.spyOn(transport, 'request').mockImplementation(async (req) => {
    const res = await real(req);
    if (transport.requests.length === n) {
      await repo.replaceLabels('u1', [{ externalId: 'b1', label: 'private', labelSource: 'manual' }], ['b1']);
    }
    return res;
  });
}

test('toMirrorInput maps the wire shape', () => {
  const e = { ...wire('e1'), category_id: 'c', category_splits: [{ category_id: 'c2', amount: '4.00' }], is_debt: true };
  expect(toMirrorInput(e)).toMatchObject({
    externalId: 'e1', categoryId: 'c', categorySplits: [{ categoryId: 'c2', amount: '4.00' }], isDebt: true,
    remoteUpdatedAt: new Date('2026-11-01T10:00:00Z'),
  });
});

test('first sync starts without a cursor and stores next_cursor after each page', async () => {
  transport.queue(CHANGES, 200, { changes: [up('e1'), up('e2')], next_cursor: 'c1', has_more: true });
  transport.queue(CHANGES, 200, { changes: [up('e3')], next_cursor: 'c2', has_more: false });
  expect(await sync.syncCompany('u1')).toBe('synced');
  expect(transport.requests.map((r) => r.query?.cursor)).toEqual([undefined, 'c1']);
  expect(account().syncCursor).toBe('c2');
  expect(repo.expenses('b1-row')).toHaveLength(3);
  expect(account().lastSyncedAt).not.toBeNull();
  expect(account().fullResyncAt).toEqual(NOW);
});

test('tombstones delete local rows and unknown ids are a no-op', async () => {
  seedCompany({ fullResyncAt: new Date(NOW.getTime() - 1000), syncCursor: 'c0' });
  repo.seedExpense('b1-row', 'e1');
  repo.seedExpense('b1-row', 'e2');
  transport.queue(CHANGES, 200, { changes: [{ type: 'delete', id: 'e1' }, { type: 'delete', id: 'zz' }], next_cursor: 'c1', has_more: false });
  expect(await sync.syncCompany('u1')).toBe('synced');
  expect(repo.expenses('b1-row').map((e) => e.externalId)).toEqual(['e2']);
});

test('an upsert of an existing id replaces it', async () => {
  seedCompany({ fullResyncAt: NOW, syncCursor: 'c0' });
  repo.seedExpense('b1-row', 'e1', { amount: '10.00' });
  transport.queue(CHANGES, 200, { changes: [up('e1', '12.00')], next_cursor: 'c1', has_more: false });
  await sync.syncCompany('u1');
  expect(repo.expenses('b1-row')).toHaveLength(1);
  expect(repo.expenses('b1-row')[0].amount).toBe('12.00');
});

test('incremental sync continues from the stored cursor', async () => {
  seedCompany({ syncCursor: 'c2', fullResyncAt: new Date(NOW.getTime() - DAY) });
  transport.queue(CHANGES, 200, { changes: [], next_cursor: 'c3', has_more: false });
  expect(await sync.syncCompany('u1')).toBe('synced');
  expect(transport.requests[0].query?.cursor).toBe('c2');
  expect(account().syncCursor).toBe('c3');
  expect(account().fullResyncAt).toEqual(new Date(NOW.getTime() - DAY));
});

test('weekly full resync sweeps rows not seen (expense moved to another account)', async () => {
  seedCompany({ syncCursor: 'c2', syncGeneration: 3, fullResyncAt: new Date(NOW.getTime() - 8 * DAY) });
  repo.seedExpense('b1-row', 'e1');
  repo.seedExpense('b1-row', 'e2');
  transport.queue(CHANGES, 200, { changes: [up('e1')], next_cursor: 'c9', has_more: false });
  expect(await sync.syncCompany('u1')).toBe('synced');
  expect(transport.requests[0].query?.cursor).toBeUndefined();
  expect(repo.expenses('b1-row').map((e) => e.externalId)).toEqual(['e1']);
  expect(account().syncGeneration).toBe(4);
  expect(account().fullResyncAt).toEqual(NOW);
  expect(FULL_RESYNC_INTERVAL_MS).toBe(7 * DAY);
});

test('invalid_cursor resets to a full resync', async () => {
  seedCompany({ syncCursor: 'bad', fullResyncAt: new Date(NOW.getTime() - DAY) });
  repo.seedExpense('b1-row', 'old');
  transport.queue(CHANGES, 400, { error: { code: 'invalid_cursor' } });
  transport.queue(CHANGES, 200, { changes: [up('e1')], next_cursor: 'c1', has_more: false });
  expect(await sync.syncCompany('u1')).toBe('synced');
  expect(transport.requests.map((r) => r.query?.cursor)).toEqual(['bad', undefined]);
  expect(repo.expenses('b1-row').map((e) => e.externalId)).toEqual(['e1']);
});

test('relabelled mid-sync: the next page is not requested or written', async () => {
  transport.queue(CHANGES, 200, { changes: [up('e1')], next_cursor: 'c1', has_more: true });
  transport.queue(CHANGES, 200, { changes: [up('e2')], next_cursor: 'c2', has_more: false });
  // relabel after page 1 was applied, before page 2
  const apply = repo.applyChangesPage.bind(repo);
  jest.spyOn(repo, 'applyChangesPage').mockImplementation(async (id, page) => {
    const r = await apply(id, page);
    await repo.replaceLabels('u1', [{ externalId: 'b1', label: 'private', labelSource: 'manual' }], ['b1']);
    return r;
  });
  expect(await sync.syncCompany('u1')).toBe('aborted_relabelled');
  expect(repo.expenses('b1-row')).toHaveLength(0);
  expect(transport.requests).toHaveLength(1);
  expect(account().fullResyncAt).toBeNull();
});

test('relabelled while a page is in flight: it is not written', async () => {
  transport.queue(CHANGES, 200, { changes: [up('e1')], next_cursor: 'c1', has_more: false });
  relabelAfterResponse(1);
  expect(await sync.syncCompany('u1')).toBe('aborted_relabelled');
  expect(repo.expenses('b1-row')).toHaveLength(0);
  expect(account().fullResyncAt).toBeNull();
  expect(account().syncCursor).toBeNull();
});

test('a concurrent sync of the same account is skipped', async () => {
  await redis.setNxPx('aib:sync:b1-row', 'x', 1000);
  expect(await sync.syncCompany('u1')).toBe('skipped_locked');
  expect(transport.requests).toHaveLength(0);
});

test('the lock is released after a run', async () => {
  transport.queue(CHANGES, 200, { changes: [], next_cursor: 'c1', has_more: false });
  await sync.syncCompany('u1');
  expect(await redis.get('aib:sync:b1-row')).toBeNull();
});

test('no company account gives no_company and no HTTP', async () => {
  seedCompany({ label: 'other_business' });
  expect(await sync.syncCompany('u1')).toBe('no_company');
  expect(transport.requests).toHaveLength(0);
});

test('reconnect required gives needs_reconnect and leaves lastSyncError unchanged', async () => {
  seedCompany({ lastSyncError: 'unavailable' });
  tokens.getAccessToken.mockRejectedValue(new AiBudgetReconnectRequiredError());
  expect(await sync.syncCompany('u1')).toBe('needs_reconnect');
  expect(account().lastSyncError).toBe('unavailable');
});

test('a failure stores lastSyncError code and keeps the old lastSyncedAt', async () => {
  const before = new Date('2026-11-02T11:00:00Z');
  seedCompany({ lastSyncedAt: before, syncCursor: 'c0', fullResyncAt: NOW });
  transport.queue(CHANGES, 503, { error: { code: 'service_unavailable' } });
  expect(await sync.syncCompany('u1')).toBe('failed');
  expect(account().lastSyncError).toBe('unavailable');
  expect(account().lastSyncedAt).toEqual(before);
});

test('changes invalidate the reconciliation cache', async () => {
  await redis.setEx('aib:recon:u1', 300, '{}');
  transport.queue(CHANGES, 200, { changes: [up('e1')], next_cursor: 'c1', has_more: false });
  await sync.syncCompany('u1');
  expect(await redis.get('aib:recon:u1')).toBeNull();
});

test('syncIfStale returns fresh when lastSyncedAt is under 5 minutes old, otherwise syncs', async () => {
  seedCompany({ lastSyncedAt: new Date(NOW.getTime() - 60_000), fullResyncAt: NOW, syncCursor: 'c0' });
  expect(await sync.syncIfStale('u1')).toBe('fresh');
  expect(transport.requests).toHaveLength(0);
  seedCompany({ lastSyncedAt: new Date(NOW.getTime() - 600_000), fullResyncAt: NOW, syncCursor: 'c0' });
  transport.queue(CHANGES, 200, { changes: [], next_cursor: 'c1', has_more: false });
  expect(await sync.syncIfStale('u1')).toBe('synced');
});

describe('a first sync is not usable until the whole run finished', () => {
  function dashboard(): AiBudgetDashboardService {
    return new AiBudgetDashboardService({
      repo, accounts: new AiBudgetAccountsService(repo, {} as never), sync: { syncIfStale: jest.fn().mockResolvedValue('fresh') },
      live: { listExpenses: jest.fn(), listCategories: jest.fn().mockResolvedValue([]) },
      reconciliation: { getSummary: jest.fn().mockResolvedValue({ state: 'ok', unmatched: 0 }) }, redis, now: () => NOW,
    });
  }

  test('after page 1 of a first full sync (has_more) the company is syncing, never ready', async () => {
    transport.queue(CHANGES, 200, { changes: [up('e1')], next_cursor: 'c1', has_more: true });
    transport.queue(CHANGES, 200, { changes: [up('e2')], next_cursor: 'c2', has_more: false });
    const states: string[] = [];
    const real = transport.request.bind(transport);
    jest.spyOn(transport, 'request').mockImplementation(async (req) => {
      if (transport.requests.length === 1) states.push((await dashboard().getCompany('u1')).state);
      return real(req);
    });
    expect(await sync.syncCompany('u1')).toBe('synced');
    expect(states).toEqual(['syncing']);
    expect((await dashboard().getCompany('u1')).state).toBe('ready');
  });

  test('a first sync that fails midway leaves no lastSyncedAt and reads sync_failed', async () => {
    transport.queue(CHANGES, 200, { changes: [up('e1')], next_cursor: 'c1', has_more: true });
    transport.queue(CHANGES, 503, { error: 'unavailable' });
    expect(await sync.syncCompany('u1')).toBe('failed');
    expect(repo.expenses('b1-row')).toHaveLength(1);
    expect(account().lastSyncedAt).toBeNull();
    expect(account().lastSyncError).toBe('unavailable');
    expect(await dashboard().getCompany('u1')).toEqual({ state: 'sync_failed' });
  });
});
