import { AiBudgetAccountsService } from '../ai-budget-accounts.service';
import { AiBudgetApiError } from '../ai-budget-errors';
import { AiBudgetExpensesService, AiBudgetWriteRefused } from '../ai-budget-expenses.service';
import { InMemoryAiBudgetRepository } from './fakes';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const wire = (id: string, amount: string, over: Record<string, unknown> = {}) => ({
  id, amount, currency: 'PLN', date: '2026-11-01', category_id: null, description: null, merchant: null, category_splits: [],
  is_debt: false, is_split_receivable: false, updated_at: '2026-11-01T10:00:00Z', encrypted_fields: [], ...over,
});

let repo: InMemoryAiBudgetRepository;
let sync: { syncIfStale: jest.Mock };
let live: { listExpenses: jest.Mock; listCategories: jest.Mock; invalidate: jest.Mock };
let api: { createExpense: jest.Mock; updateExpense: jest.Mock; deleteExpense: jest.Mock };
let reconciliation: { invalidate: jest.Mock };
let svc: AiBudgetExpensesService;

function build(syncBoundMs?: number): AiBudgetExpensesService {
  return new AiBudgetExpensesService({
    repo, accounts: new AiBudgetAccountsService(repo, {} as never), sync, live, api, reconciliation, ...(syncBoundMs ? { syncBoundMs } : {}),
  });
}

beforeEach(() => {
  repo = new InMemoryAiBudgetRepository();
  repo.seedConnection('u1');
  repo.seedAccount('u1', { externalId: 'b1', name: 'Firma A', type: 'business', label: 'company', access: 'read_write', lastSyncedAt: new Date('2026-11-02T10:00:00Z') });
  repo.seedAccount('u1', { externalId: 'p', name: 'Personal', type: 'personal', label: 'private', access: 'read_write' });
  sync = { syncIfStale: jest.fn().mockResolvedValue('fresh') };
  live = {
    listExpenses: jest.fn().mockResolvedValue({ expenses: [wire('pe1', '40.00')], truncated: false }),
    listCategories: jest.fn().mockResolvedValue([{ id: 'c-food', name: 'Food', type: 'expense' }, { id: 'c-fuel', name: 'Fuel', type: 'expense' }]),
    invalidate: jest.fn().mockResolvedValue(undefined),
  };
  api = {
    createExpense: jest.fn().mockResolvedValue(wire('new1', '100.50')),
    updateExpense: jest.fn().mockResolvedValue(wire('e1', '12.00')),
    deleteExpense: jest.fn().mockResolvedValue(undefined),
  };
  reconciliation = { invalidate: jest.fn().mockResolvedValue(undefined) };
  svc = build();
});

const rows = async () => repo.listAccounts('u1');

test('company reads come from the mirror after a bounded on-demand sync; others are read live', async () => {
  repo.seedExpense('b1-row', 'ce1', { amount: '100.00', date: '2026-11-01' });
  repo.seedExpense('b1-row', 'old', { amount: '9.00', date: '2026-09-01' });
  const r = await svc.query('u1', { accounts: await rows(), dateFrom: '2026-11-01', dateTo: '2026-11-30' });

  expect(sync.syncIfStale).toHaveBeenCalledWith('u1');
  expect(live.listExpenses).toHaveBeenCalledTimes(1);
  expect(live.listExpenses.mock.calls[0][1]).toMatchObject({ id: 'p-row', externalId: 'p' });
  expect(r.expenses.map((e) => [e.id, e.label, e.amountCents])).toEqual(expect.arrayContaining([['ce1', 'company', 10000], ['pe1', 'private', 4000]]));
  expect(r.expenses).toHaveLength(2);
  expect(r.companyAsOf).toEqual(new Date('2026-11-02T10:00:00Z'));
  expect(r.companyPending).toBe(false);
});

test('a sync that outlives the bound does not block the read: mirror answered and flagged pending', async () => {
  sync.syncIfStale.mockReturnValue(new Promise(() => undefined));
  svc = build(20);
  repo.seedExpense('b1-row', 'ce1', { amount: '100.00' });
  const company = (await rows()).filter((a) => a.label === 'company');
  const r = await svc.query('u1', { accounts: company, dateFrom: '2026-11-01', dateTo: '2026-11-30' });
  expect(r.expenses.map((e) => e.id)).toEqual(['ce1']);
  expect(r.companyPending).toBe(true);
});

test('a never-synced company whose sync failed is sync_failed, not syncing', async () => {
  repo.accountRows.set('b1-row', { ...repo.accountRows.get('b1-row')!, lastSyncedAt: null, lastSyncError: 'unavailable' });
  sync.syncIfStale.mockResolvedValue('failed');
  const company = (await rows()).filter((a) => a.label === 'company');
  const r = await svc.query('u1', { accounts: company, dateFrom: '2026-11-01', dateTo: '2026-11-30' });
  expect(r).toMatchObject({ companySyncFailed: true, companyPending: false, companyAsOf: null });
  expect(await svc.ensureCompanyFresh('u1')).toMatchObject({ syncFailed: true, pending: false });
  sync.syncIfStale.mockResolvedValue('skipped_locked');
  expect(await svc.ensureCompanyFresh('u1')).toMatchObject({ syncFailed: false, pending: true });
  sync.syncIfStale.mockRejectedValue(new Error('boom'));
  expect(await svc.ensureCompanyFresh('u1')).toMatchObject({ syncFailed: true });
});

test('a never-synced company is pending, not an empty month', async () => {
  repo.accountRows.set('b1-row', { ...repo.accountRows.get('b1-row')!, lastSyncedAt: null });
  const r = await svc.query('u1', { accounts: (await rows()).filter((a) => a.label === 'company'), dateFrom: '2026-11-01', dateTo: '2026-11-30' });
  expect(r.companyPending).toBe(true);
  expect(r.companyAsOf).toBeNull();
});

test('inactive accounts are never read', async () => {
  repo.accountRows.set('p-row', { ...repo.accountRows.get('p-row')!, active: false, inactiveReason: 'role' });
  await svc.query('u1', { accounts: await rows(), dateFrom: '2026-11-01', dateTo: '2026-11-30' });
  expect(live.listExpenses).not.toHaveBeenCalled();
});

test('company text and category filters apply to the mirror; splits decide the category and its share', async () => {
  repo.seedExpense('b1-row', 'a', { merchant: 'Biedronka', categoryId: 'c-food', amount: '10.00' });
  repo.seedExpense('b1-row', 'b', { merchant: 'Orlen', amount: '50.00', categorySplits: [{ categoryId: 'c-food', amount: '5.00' }, { categoryId: 'c-fuel', amount: '45.00' }], categoryId: 'c-fuel' });
  repo.seedExpense('b1-row', 'c', { merchant: 'Orlen', categoryId: 'c-fuel' });
  const company = (await rows()).filter((a) => a.label === 'company');
  const byText = await svc.query('u1', { accounts: company, dateFrom: '2026-11-01', dateTo: '2026-11-30', text: 'bied' });
  expect(byText.expenses.map((e) => e.id)).toEqual(['a']);
  const byCat = await svc.query('u1', { accounts: company, dateFrom: '2026-11-01', dateTo: '2026-11-30', categoryName: 'food' });
  expect(Object.fromEntries(byCat.expenses.map((e) => [e.id, e.matchedCents]))).toEqual({ a: 1000, b: 500 });
  expect(byCat.expenses.find((e) => e.id === 'b')!.amountCents).toBe(5000);
});

test('own category Food with every split Fuel is not a Food expense (splits decide)', async () => {
  repo.seedExpense('b1-row', 'x', { categoryId: 'c-food', amount: '30.00', categorySplits: [{ categoryId: 'c-fuel', amount: '30.00' }] });
  const company = (await rows()).filter((a) => a.label === 'company');
  const food = await svc.query('u1', { accounts: company, dateFrom: '2026-11-01', dateTo: '2026-11-30', categoryName: 'Food' });
  expect(food.expenses).toEqual([]);
  const fuel = await svc.query('u1', { accounts: company, dateFrom: '2026-11-01', dateTo: '2026-11-30', categoryName: ' FUEL ' });
  expect(fuel.expenses.map((e) => [e.id, e.matchedCents])).toEqual([['x', 3000]]);
});

test('live rows get the same local category attribution; no server-side category filter is sent', async () => {
  live.listExpenses.mockResolvedValueOnce({
    expenses: [
      wire('l1', '20.00', { category_id: 'c-food', category_splits: [{ category_id: 'c-fuel', amount: '20.00' }] }),
      wire('l2', '8.00', { category_id: 'c-fuel', category_splits: [{ category_id: 'c-food', amount: '3.00' }, { category_id: 'c-fuel', amount: '5.00' }] }),
      wire('l3', '4.00', { category_id: 'c-food' }),
    ],
    truncated: false,
  });
  const priv = (await rows()).filter((a) => a.label === 'private');
  const r = await svc.query('u1', { accounts: priv, dateFrom: '2026-11-01', dateTo: '2026-11-30', categoryName: 'Food' });
  expect(live.listExpenses.mock.calls[0][2]).not.toHaveProperty('categoryId');
  expect(r.expenses.map((e) => [e.id, e.matchedCents]).sort()).toEqual([['l2', 300], ['l3', 400]]);
});

test('a text filter is never sent to AI Budget: live rows are filtered locally on merchant and description', async () => {
  live.listExpenses.mockResolvedValueOnce({
    expenses: [wire('m', '5.00', { merchant: 'Biedronka' }), wire('d', '6.00', { description: 'zakupy w biedronce' }), wire('o', '7.00', { merchant: 'Orlen' })],
    truncated: false,
  });
  const priv = (await rows()).filter((a) => a.label === 'private');
  const r = await svc.query('u1', { accounts: priv, dateFrom: '2026-11-01', dateTo: '2026-11-30', text: 'BIEDRON' });
  expect(live.listExpenses.mock.calls[0][2]).toEqual({ dateFrom: '2026-11-01', dateTo: '2026-11-30' });
  expect(r.expenses.map((e) => e.id).sort()).toEqual(['d', 'm']);
  expect(r.searchLimited).toEqual([]);
});

test('company and private answers to the same text question agree (same local rule)', async () => {
  repo.seedExpense('b1-row', 'c1', { merchant: 'Biedronka' });
  live.listExpenses.mockResolvedValueOnce({ expenses: [wire('p1', '5.00', { merchant: 'Biedronka' })], truncated: false });
  const r = await svc.query('u1', { accounts: await rows(), dateFrom: '2026-11-01', dateTo: '2026-11-30', text: 'biedronka' });
  expect(r.expenses.map((e) => e.id).sort()).toEqual(['c1', 'p1']);
});

test('a text search over rows with encrypted merchant or description notes the limit for that account', async () => {
  live.listExpenses.mockResolvedValueOnce({
    expenses: [wire('x', '1.00', { description: 'kino' }), wire('y', '2.00', { merchant: null, encrypted_fields: ['merchant'] })],
    truncated: false,
  });
  const priv = (await rows()).filter((a) => a.label === 'private');
  const r = await svc.query('u1', { accounts: priv, dateFrom: '2026-11-01', dateTo: '2026-11-30', text: 'KINO' });
  expect(r.expenses.map((e) => e.id)).toEqual(['x']);
  expect(r.searchLimited).toEqual(['p']);
});

test('an unknown category name lists the available names instead of answering "no expenses"', async () => {
  const r = await svc.query('u1', { accounts: await rows(), dateFrom: '2026-11-01', dateTo: '2026-11-30', categoryName: 'Travel' });
  expect(r.expenses).toEqual([]);
  expect(r.unknownCategory).toEqual(['Food', 'Fuel']);
});

test('a category name is resolved per account (ids differ between accounts)', async () => {
  repo.seedExpense('b1-row', 'c1', { categoryId: 'co-food', amount: '3.00' });
  live.listCategories.mockImplementation(async (_u: string, a: { externalId: string }) =>
    a.externalId === 'b1' ? [{ id: 'co-food', name: 'Food', type: 'expense' }] : [{ id: 'p-food', name: 'food', type: 'expense' }]);
  live.listExpenses.mockResolvedValueOnce({ expenses: [wire('p1', '4.00', { category_id: 'p-food' }), wire('p2', '9.00', { category_id: 'co-food' })], truncated: false });
  const r = await svc.query('u1', { accounts: await rows(), dateFrom: '2026-11-01', dateTo: '2026-11-30', categoryName: 'Food' });
  expect(r.expenses.map((e) => [e.id, e.matchedCents]).sort()).toEqual([['c1', 300], ['p1', 400]]);
  expect(r.unknownCategory).toBeUndefined();
});

test('categories that cannot be loaded make that account unknown, not empty', async () => {
  live.listCategories.mockImplementation(async (_u: string, a: { externalId: string }) => {
    if (a.externalId === 'p') throw new AiBudgetApiError(503, 'http_503');
    return [{ id: 'c-food', name: 'Food', type: 'expense' }];
  });
  const r = await svc.query('u1', { accounts: await rows(), dateFrom: '2026-11-01', dateTo: '2026-11-30', categoryName: 'Food' });
  expect(r.failed).toEqual([{ accountExternalId: 'p', code: 'http_503' }]);
});

test('a failed live read is reported per account, never as an empty account', async () => {
  live.listExpenses.mockRejectedValueOnce(new AiBudgetApiError(503, 'http_503'));
  const r = await svc.query('u1', { accounts: await rows(), dateFrom: '2026-11-01', dateTo: '2026-11-30' });
  expect(r.failed).toEqual([{ accountExternalId: 'p', code: 'http_503' }]);
});

test('company write goes to AI Budget first, then updates the mirror from the response', async () => {
  const v = await svc.create('u1', 'b1-row', { amount: '100.5', date: '2026-11-01', merchant: 'Biedronka' });
  expect(api.createExpense).toHaveBeenCalledWith('u1', 'b1', { amount: '100.5', date: '2026-11-01', merchant: 'Biedronka' }, expect.any(String));
  expect((await repo.findMirrorExpense('b1-row', 'new1'))?.amount).toBe('100.50');
  expect(v).toMatchObject({ id: 'new1', accountExternalId: 'b1', accountName: 'Firma A', label: 'company', amountCents: 10050 });
  expect(live.invalidate).not.toHaveBeenCalled();
});

test('company update and delete keep the mirror in step', async () => {
  repo.seedExpense('b1-row', 'e1', { amount: '10.00' });
  await svc.update('u1', 'b1-row', 'e1', { amount: '12', merchant: null });
  expect(api.updateExpense).toHaveBeenCalledWith('u1', 'b1', 'e1', { amount: '12', merchant: null });
  expect((await repo.findMirrorExpense('b1-row', 'e1'))?.amount).toBe('12.00');
  await svc.remove('u1', 'b1-row', 'e1');
  expect(api.deleteExpense).toHaveBeenCalledWith('u1', 'b1', 'e1');
  expect(await repo.findMirrorExpense('b1-row', 'e1')).toBeNull();
});

test('private write invalidates that account cache and writes nothing to the DB', async () => {
  const upsert = jest.spyOn(repo, 'upsertMirrorExpense');
  await svc.create('u1', 'p-row', { amount: '40', date: '2026-11-01' });
  await svc.update('u1', 'p-row', 'pe1', { description: 'x' });
  await svc.remove('u1', 'p-row', 'pe1');
  expect(live.invalidate).toHaveBeenCalledWith('u1', 'p-row');
  expect(live.invalidate).toHaveBeenCalledTimes(3);
  expect(upsert).not.toHaveBeenCalled();
  expect(repo.expenses('p-row')).toEqual([]);
});

test('a company relabelled during the write is not mirrored (the repository guard refuses it)', async () => {
  const upsert = jest.spyOn(repo, 'upsertMirrorExpense');
  api.createExpense.mockImplementation(async () => {
    repo.accountRows.set('b1-row', { ...repo.accountRows.get('b1-row')!, label: 'private' });
    return wire('new1', '5.00');
  });
  await svc.create('u1', 'b1-row', { amount: '5', date: '2026-11-01' });
  await expect(upsert.mock.results[0].value).resolves.toBe('not_company');
  expect(repo.expenses('b1-row')).toEqual([]);
  expect(live.invalidate).toHaveBeenCalledWith('u1', 'b1-row');
  expect(reconciliation.invalidate).not.toHaveBeenCalled();
});

test('read-only and inactive accounts are refused before any HTTP call', async () => {
  repo.seedAccount('u1', { externalId: 'ro', label: 'private', access: 'read' });
  repo.seedAccount('u1', { externalId: 'off', label: 'private', access: 'read_write', active: false, inactiveReason: 'archived' });
  repo.seedAccount('u1', { externalId: 'gone', label: 'private', access: 'read_write', name: '', type: '', active: false });
  await expect(svc.create('u1', 'ro-row', { amount: '1', date: '2026-11-01' })).rejects.toEqual(new AiBudgetWriteRefused('read_only'));
  await expect(svc.update('u1', 'off-row', 'e', { amount: '1' })).rejects.toMatchObject({ reason: 'inactive' });
  await expect(svc.remove('u1', 'gone-row', 'e')).rejects.toMatchObject({ reason: 'inactive' });
  await expect(svc.remove('u1', 'nope-row', 'e')).rejects.toMatchObject({ reason: 'unknown_account' });
  await expect(svc.remove('u2', 'p-row', 'e')).rejects.toMatchObject({ reason: 'unknown_account' });
  expect(api.createExpense).not.toHaveBeenCalled();
  expect(api.updateExpense).not.toHaveBeenCalled();
  expect(api.deleteExpense).not.toHaveBeenCalled();
});

test('categoryName resolves case-insensitively; unknown → unknown_category', async () => {
  await svc.create('u1', 'p-row', { amount: '1', date: '2026-11-01', categoryName: '  fOOd ' });
  expect(api.createExpense.mock.calls[0][2]).toMatchObject({ category_id: 'c-food' });
  await svc.update('u1', 'p-row', 'e', { categoryName: null });
  expect(api.updateExpense.mock.calls[0][3]).toEqual({ category_id: null });

  const err = await svc.create('u1', 'p-row', { amount: '1', date: '2026-11-01', categoryName: 'Taxes' }).catch((e) => e);
  expect(err).toBeInstanceOf(AiBudgetWriteRefused);
  expect(err.reason).toBe('unknown_category');
  expect(err.available).toEqual(['Food', 'Fuel']);
  expect(api.createExpense).toHaveBeenCalledTimes(1);
});

test('create sends a fresh UUID Idempotency-Key and retries a timeout once with the same key', async () => {
  api.createExpense.mockRejectedValueOnce(new AiBudgetApiError(0, 'timeout')).mockResolvedValueOnce(wire('n1', '1.00'));
  await svc.create('u1', 'p-row', { amount: '1', date: '2026-11-01' });
  expect(api.createExpense).toHaveBeenCalledTimes(2);
  const [k1, k2] = api.createExpense.mock.calls.map((c) => c[3]);
  expect(k1).toMatch(UUID_V4);
  expect(k2).toBe(k1);

  api.createExpense.mockResolvedValueOnce(wire('n2', '1.00'));
  await svc.create('u1', 'p-row', { amount: '1', date: '2026-11-01' });
  expect(api.createExpense.mock.calls[2][3]).not.toBe(k1);

  api.createExpense.mockRejectedValueOnce(new AiBudgetApiError(0, 'timeout')).mockRejectedValueOnce(new AiBudgetApiError(0, 'timeout'));
  await expect(svc.create('u1', 'p-row', { amount: '1', date: '2026-11-01' })).rejects.toMatchObject({ code: 'timeout' });
  expect(api.createExpense).toHaveBeenCalledTimes(5);
});

test('a 4xx on create is not retried', async () => {
  api.createExpense.mockRejectedValueOnce(new AiBudgetApiError(422, 'validation_failed'));
  await expect(svc.create('u1', 'p-row', { amount: '1', date: '2026-11-01' })).rejects.toMatchObject({ status: 422 });
  expect(api.createExpense).toHaveBeenCalledTimes(1);
});

test('companyOnly writes refuse any account that is not the company, read fresh from the repository', async () => {
  await expect(svc.create('u1', 'p-row', { amount: '1', date: '2026-11-01' }, { companyOnly: true })).rejects.toMatchObject({ reason: 'unknown_account' });
  await expect(svc.update('u1', 'p-row', 'e', { amount: '1' }, { companyOnly: true })).rejects.toMatchObject({ reason: 'unknown_account' });
  await expect(svc.remove('u1', 'p-row', 'e', { companyOnly: true })).rejects.toMatchObject({ reason: 'unknown_account' });
  expect(api.createExpense).not.toHaveBeenCalled();
  await svc.create('u1', 'b1-row', { amount: '1', date: '2026-11-01' }, { companyOnly: true });
  expect(api.createExpense).toHaveBeenCalledTimes(1);
});

test('company writes bust the reconciliation cache; a 404 delete removes the mirror row', async () => {
  await svc.create('u1', 'b1-row', { amount: '1', date: '2026-11-01' });
  await svc.update('u1', 'b1-row', 'new1', { amount: '2' });
  repo.seedExpense('b1-row', 'gone', {});
  api.deleteExpense.mockRejectedValueOnce(new AiBudgetApiError(404, 'not_found'));
  await expect(svc.remove('u1', 'b1-row', 'gone')).rejects.toMatchObject({ status: 404 });
  expect(await repo.findMirrorExpense('b1-row', 'gone')).toBeNull();
  expect(reconciliation.invalidate).toHaveBeenCalledTimes(3);
  expect(reconciliation.invalidate).toHaveBeenCalledWith('u1');

  await svc.create('u1', 'p-row', { amount: '1', date: '2026-11-01' });
  api.deleteExpense.mockRejectedValueOnce(new AiBudgetApiError(404, 'not_found'));
  await expect(svc.remove('u1', 'p-row', 'x')).rejects.toMatchObject({ status: 404 });
  expect(reconciliation.invalidate).toHaveBeenCalledTimes(3);
});

test('a company write on a connection that is no longer active is not mirrored', async () => {
  await repo.setConnectionStatus('u1', 'needs_reconnect', new Date());
  await svc.create('u1', 'b1-row', { amount: '1', date: '2026-11-01' });
  expect(await repo.findMirrorExpense('b1-row', 'new1')).toBeNull();
  expect(live.invalidate).toHaveBeenCalledWith('u1', 'b1-row');
  expect(reconciliation.invalidate).not.toHaveBeenCalled();
});

test('a category name with every account\'s categories failing reports the accounts as unknown, never "no such category"', async () => {
  live.listCategories.mockRejectedValue(new AiBudgetApiError(503, 'http_503'));
  const r = await svc.query('u1', { accounts: await rows(), dateFrom: '2026-11-01', dateTo: '2026-11-30', categoryName: 'Travel' });
  expect(r.unknownCategory).toBeUndefined();
  expect(r.failed.map((f) => f.accountExternalId).sort()).toEqual(['b1', 'p']);
});

test('a category name missing from the loaded accounts while another account failed is not reported as unknown', async () => {
  live.listCategories.mockImplementation(async (_u: string, a: { externalId: string }) => {
    if (a.externalId === 'p') throw new AiBudgetApiError(503, 'http_503');
    return [{ id: 'c-food', name: 'Food', type: 'expense' }];
  });
  const r = await svc.query('u1', { accounts: await rows(), dateFrom: '2026-11-01', dateTo: '2026-11-30', categoryName: 'Travel' });
  expect(r.unknownCategory).toBeUndefined();
  expect(r.failed).toEqual([{ accountExternalId: 'p', code: 'http_503' }]);
});
