import { AiBudgetAccountsService } from '../ai-budget-accounts.service';
import { AiBudgetDashboardService } from '../ai-budget-dashboard.service';
import { FakeRedis, InMemoryAiBudgetRepository } from './fakes';

const NOW = new Date('2026-11-02T12:00:00Z');
const wire = (id: string, date: string, amount: string, over: Record<string, unknown> = {}) => ({
  id, amount, currency: 'PLN', date, category_id: null, description: null, merchant: null, category_splits: [],
  is_debt: false, is_split_receivable: false, updated_at: '2026-11-01T00:00:00Z', encrypted_fields: [], ...over,
});

let repo: InMemoryAiBudgetRepository;
let redis: FakeRedis;
let sync: { syncIfStale: jest.Mock };
let live: { listExpenses: jest.Mock; listCategories: jest.Mock };
let reconciliation: { getSummary: jest.Mock };
let dash: AiBudgetDashboardService;
const COMPANY = 'b1-row';

beforeEach(() => {
  repo = new InMemoryAiBudgetRepository();
  repo.seedConnection('u1');
  redis = new FakeRedis();
  sync = { syncIfStale: jest.fn().mockResolvedValue('fresh') };
  live = { listExpenses: jest.fn().mockResolvedValue({ expenses: [], truncated: false }), listCategories: jest.fn().mockResolvedValue([]) };
  reconciliation = { getSummary: jest.fn().mockResolvedValue({ state: 'wfirma_not_connected' }) };
  dash = new AiBudgetDashboardService({
    repo, accounts: new AiBudgetAccountsService(repo, {} as never), sync, live, reconciliation, redis, now: () => NOW,
  });
});

const seedCompany = (over: Record<string, unknown> = {}) =>
  repo.seedAccount('u1', { externalId: 'b1', type: 'business', label: 'company', lastSyncedAt: new Date('2026-11-02T11:59:00Z'), ...over });

describe('getCompany', () => {
  test('not connected / revoked', async () => {
    expect(await dash.getCompany('nobody')).toEqual({ state: 'not_connected' });
    await repo.clearTokens('u1');
    expect(await dash.getCompany('u1')).toEqual({ state: 'not_connected' });
  });

  test('needs_reconnect never returns figures even when mirror rows exist', async () => {
    seedCompany();
    repo.seedExpense(COMPANY, 'e1', { date: '2026-11-01' });
    await repo.setConnectionStatus('u1', 'needs_reconnect', NOW);
    expect(await dash.getCompany('u1')).toEqual({ state: 'needs_reconnect' });
    expect(reconciliation.getSummary).not.toHaveBeenCalled();
  });

  test('never synced and sync running → syncing, not zeros', async () => {
    seedCompany({ lastSyncedAt: null });
    await redis.setNxPx(`aib:sync:${COMPANY}`, 'x', 60_000);
    expect(await dash.getCompany('u1')).toEqual({ state: 'syncing' });
  });

  test('never synced and last sync failed → sync_failed', async () => {
    seedCompany({ lastSyncedAt: null, lastSyncError: 'upstream_error' });
    expect(await dash.getCompany('u1')).toEqual({ state: 'sync_failed' });
  });

  test('several business accounts, none chosen → no_company_account with needsCompanyChoice', async () => {
    await repo.setNeedsCompanyChoice('u1', true);
    repo.seedAccount('u1', { externalId: 'b1', type: 'business', label: 'other_business' });
    repo.seedAccount('u1', { externalId: 'b2', type: 'business', label: 'other_business' });
    expect(await dash.getCompany('u1')).toEqual({ state: 'no_company_account', needsCompanyChoice: true });
  });

  test('inactive company → company_inactive with the reason, no figures', async () => {
    seedCompany({ active: false, inactiveReason: 'archived', name: 'Firma' });
    expect(await dash.getCompany('u1')).toEqual({ state: 'company_inactive', accountName: 'Firma', reason: 'archived' });
  });

  test('company spending: this month vs last month per currency, one line per currency, debts and split receivables excluded', async () => {
    seedCompany();
    repo.seedExpense(COMPANY, 'a', { date: '2026-11-01', amount: '100.00' });
    repo.seedExpense(COMPANY, 'b', { date: '2026-11-01', amount: '50.00', isDebt: true });
    repo.seedExpense(COMPANY, 'c', { date: '2026-11-01', amount: '20.00', isSplitReceivable: true });
    repo.seedExpense(COMPANY, 'd', { date: '2026-10-15', amount: '80.00' });
    repo.seedExpense(COMPANY, 'e', { date: '2026-11-02', amount: '10.00', currency: 'EUR' });
    repo.seedExpense(COMPANY, 'old', { date: '2026-09-30', amount: '999.00' });
    const r = (await dash.getCompany('u1')) as { spending: unknown };
    expect(r.spending).toEqual([{ currency: 'EUR', current: 10, previous: 0 }, { currency: 'PLN', current: 100, previous: 80 }]);
  });

  test('category breakdown follows splits and resolves names via live categories', async () => {
    seedCompany();
    live.listCategories.mockResolvedValue([{ id: 'c1', name: 'Food', type: 'expense' }, { id: 'c2', name: 'Fuel', type: 'expense' }]);
    repo.seedExpense(COMPANY, 'a', { date: '2026-11-01', amount: '100.00', categoryId: 'c1' });
    repo.seedExpense(COMPANY, 'b', { date: '2026-11-01', amount: '60.00', categoryId: 'c1', categorySplits: [{ categoryId: 'c2', amount: '40.00' }, { categoryId: 'c1', amount: '20.00' }] });
    repo.seedExpense(COMPANY, 'u', { date: '2026-11-01', amount: '5.00' });
    repo.seedExpense(COMPANY, 'prev', { date: '2026-10-01', amount: '500.00', categoryId: 'c2' });
    const r = (await dash.getCompany('u1')) as { categories: unknown; currentMonth: string };
    expect(r.currentMonth).toBe('2026-11');
    expect(r.categories).toEqual([{ currency: 'PLN', items: [
      { categoryId: 'c1', categoryName: 'Food', total: 120 },
      { categoryId: 'c2', categoryName: 'Fuel', total: 40 },
      { categoryId: null, categoryName: null, total: 5 },
    ] }]);
  });

  test('private and other-business accounts never enter company figures and are never read live', async () => {
    seedCompany();
    repo.seedAccount('u1', { externalId: 'p1', label: 'private' });
    repo.seedAccount('u1', { externalId: 'o1', type: 'business', label: 'other_business' });
    repo.seedExpense('p1-row', 'x', { date: '2026-11-01', amount: '777.00' });
    repo.seedExpense('o1-row', 'y', { date: '2026-11-01', amount: '888.00' });
    const r = (await dash.getCompany('u1')) as { spending: unknown };
    expect(r.spending).toEqual([]);
    expect(live.listExpenses).not.toHaveBeenCalled();
  });

  test('triggers syncIfStale and reports sync.state and reconciliation', async () => {
    seedCompany();
    const ok = (await dash.getCompany('u1')) as { sync: unknown; reconciliation: unknown };
    expect(sync.syncIfStale).toHaveBeenCalledWith('u1');
    expect(ok.sync).toEqual({ state: 'ok', lastSyncedAt: '2026-11-02T11:59:00.000Z' });
    expect(ok.reconciliation).toEqual({ state: 'wfirma_not_connected' });

    await repo.updateAccountSync(COMPANY, { lastSyncError: 'upstream_error' });
    expect(((await dash.getCompany('u1')) as { sync: { state: string } }).sync.state).toBe('failed');
    await redis.setNxPx(`aib:sync:${COMPANY}`, 'x', 60_000);
    expect(((await dash.getCompany('u1')) as { sync: { state: string } }).sync.state).toBe('syncing');
  });

  test('a rejected background sync does not break the response', async () => {
    seedCompany();
    sync.syncIfStale.mockRejectedValue(new Error('boom'));
    expect((await dash.getCompany('u1')).state).toBe('ready');
  });
});

describe('getPersonal', () => {
  const seedPrivate = (ext: string, over: Record<string, unknown> = {}) => repo.seedAccount('u1', { externalId: ext, label: 'private', ...over });

  test('only private accounts, six-month trend oldest first, per currency; other_business ignored', async () => {
    seedPrivate('p1');
    repo.seedAccount('u1', { externalId: 'o1', type: 'business', label: 'other_business' });
    seedCompany();
    live.listExpenses.mockResolvedValue({
      expenses: [wire('1', '2026-11-01', '10.50'), wire('2', '2026-06-30', '3.00'), wire('3', '2026-11-02', '4.00', { currency: 'EUR' }), wire('4', '2026-11-02', '9.00', { is_debt: true })],
      truncated: false,
    });
    const r = (await dash.getPersonal('u1')) as { trend: { month: string; totals: unknown }[]; thisMonth: unknown };
    expect(live.listExpenses).toHaveBeenCalledTimes(1);
    expect(live.listExpenses).toHaveBeenCalledWith('u1', expect.objectContaining({ externalId: 'p1' }), { dateFrom: '2026-06-01', dateTo: '2026-11-30' });
    expect(r.trend.map((t) => t.month)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    expect(r.trend[0].totals).toEqual([{ currency: 'PLN', total: 3 }]);
    expect(r.trend[1].totals).toEqual([]);
    expect(r.thisMonth).toEqual([{ currency: 'EUR', total: 4 }, { currency: 'PLN', total: 10.5 }]);
  });

  test('categories merge by name across accounts', async () => {
    seedPrivate('p1');
    seedPrivate('p2');
    live.listExpenses
      .mockResolvedValueOnce({ expenses: [wire('1', '2026-11-01', '10.00', { category_id: 'a' })], truncated: false })
      .mockResolvedValueOnce({ expenses: [wire('2', '2026-11-01', '5.00', { category_id: 'z' })], truncated: true });
    live.listCategories
      .mockResolvedValueOnce([{ id: 'a', name: 'Food', type: 'expense' }])
      .mockResolvedValueOnce([{ id: 'z', name: 'food', type: 'expense' }]);
    const r = (await dash.getPersonal('u1')) as { categories: unknown; truncated: boolean };
    expect(r.truncated).toBe(true);
    expect(r.categories).toEqual([{ currency: 'PLN', items: [{ categoryId: 'a', categoryName: 'Food', total: 15 }] }]);
  });

  test('one private account failing → failedAccounts 1 and figures from the rest; all failing → error', async () => {
    seedPrivate('p1');
    seedPrivate('p2');
    live.listExpenses
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValueOnce({ expenses: [wire('1', '2026-11-01', '7.00')], truncated: false });
    const r = (await dash.getPersonal('u1')) as { failedAccounts: number; thisMonth: unknown };
    expect(r.failedAccounts).toBe(1);
    expect(r.thisMonth).toEqual([{ currency: 'PLN', total: 7 }]);

    live.listExpenses.mockRejectedValue(new Error('x'));
    expect(await dash.getPersonal('u1')).toEqual({ state: 'error' });
  });

  test('inactive private account excluded, never read, and counted', async () => {
    seedPrivate('p1');
    seedPrivate('p2', { active: false, inactiveReason: 'role' });
    const r = (await dash.getPersonal('u1')) as { inactiveAccounts: number; accounts: unknown };
    expect(r.inactiveAccounts).toBe(1);
    expect(r.accounts).toEqual([{ name: 'p1', currency: 'PLN' }]);
    expect(live.listExpenses).toHaveBeenCalledTimes(1);
  });

  test('gates: needs_reconnect, not_connected, no private accounts, none active', async () => {
    expect(await dash.getPersonal('nobody')).toEqual({ state: 'not_connected' });
    seedCompany();
    expect(await dash.getPersonal('u1')).toEqual({ state: 'no_private_accounts' });
    seedPrivate('p1', { active: false });
    expect(await dash.getPersonal('u1')).toEqual({ state: 'no_private_accounts' });
    await repo.setConnectionStatus('u1', 'needs_reconnect', NOW);
    expect(await dash.getPersonal('u1')).toEqual({ state: 'needs_reconnect' });
    expect(live.listExpenses).not.toHaveBeenCalled();
  });
});
