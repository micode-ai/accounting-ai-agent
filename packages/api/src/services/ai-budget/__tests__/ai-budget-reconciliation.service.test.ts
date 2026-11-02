import { AiBudgetAccountsService } from '../ai-budget-accounts.service';
import { AiBudgetReconciliationService, RECON_CACHE_TTL_SECONDS } from '../ai-budget-reconciliation.service';
import { FakeRedis, InMemoryAiBudgetRepository } from './fakes';

const NOW = new Date('2026-11-02T12:00:00Z');
const wfExp = (id: string, date: string, total: number, currency = 'PLN', contractorName = 'Bistro') => ({
  id, date: new Date(`${date}T00:00:00Z`), total, currency, contractorName,
});

let repo: InMemoryAiBudgetRepository;
let redis: FakeRedis;
let findExpenses: jest.Mock;
let factory: { hasUserCredentials: jest.Mock; getServiceForUser: jest.Mock };
let svc: AiBudgetReconciliationService;
const COMPANY = 'b1-row';

beforeEach(() => {
  repo = new InMemoryAiBudgetRepository();
  repo.seedConnection('u1');
  repo.seedAccount('u1', { externalId: 'b1', type: 'business', label: 'company' });
  redis = new FakeRedis();
  findExpenses = jest.fn().mockResolvedValue([]);
  factory = {
    hasUserCredentials: jest.fn().mockResolvedValue(true),
    getServiceForUser: jest.fn().mockResolvedValue({ findExpenses }),
  };
  svc = new AiBudgetReconciliationService(repo, new AiBudgetAccountsService(repo, {} as never), factory as never, redis, () => NOW);
});

test('scope is the previous month through today, debts and split receivables excluded', async () => {
  repo.seedExpense(COMPANY, 'old', { date: '2026-09-30' });
  repo.seedExpense(COMPANY, 'in1', { date: '2026-10-01' });
  repo.seedExpense(COMPANY, 'in2', { date: '2026-11-02' });
  repo.seedExpense(COMPANY, 'debt', { date: '2026-10-05', isDebt: true });
  repo.seedExpense(COMPANY, 'split', { date: '2026-10-05', isSplitReceivable: true });
  const list = await svc.listUnmatched('u1');
  if (list.state !== 'ok') throw new Error('expected ok');
  const ids = list.items.map((i) => i.expenseId).sort();
  expect(ids).toEqual(['in1', 'in2']);
  expect(await svc.getSummary('u1')).toMatchObject({ state: 'ok', window: { from: '2026-10-01', to: '2026-11-02' }, unmatchedCount: 2 });
});

test('wFirma is queried from window start - 7 to today + 7 and no usage is counted', async () => {
  const usage = jest.fn();
  factory.getServiceForUser.mockResolvedValue({ findExpenses, checkWFirmaLimit: usage, incrementWFirmaUsage: usage });
  await svc.getSummary('u1');
  expect(findExpenses).toHaveBeenCalledWith({ dateFrom: new Date('2026-09-24'), dateTo: new Date('2026-11-09'), limit: 1000 });
  expect(usage).not.toHaveBeenCalled();
});

test('a matching document removes the expense', async () => {
  repo.seedExpense(COMPANY, 'e1', { amount: '10.00', date: '2026-10-10', merchant: 'Bistro' });
  findExpenses.mockResolvedValue([wfExp('w1', '2026-10-12', 10)]);
  expect(await svc.getSummary('u1')).toMatchObject({ state: 'ok', unmatchedCount: 0 });
});

test('dismissed items are excluded and counted, and dismissal survives a resync', async () => {
  repo.seedExpense(COMPANY, 'e1', { date: '2026-10-10' });
  repo.seedExpense(COMPANY, 'e2', { date: '2026-10-11', amount: '20.00' });
  expect(await svc.dismiss('u1', 'e1', 'cash')).toBe('dismissed');
  expect(await svc.getSummary('u1')).toMatchObject({ unmatchedCount: 1, dismissedCount: 1 });
  repo.seedExpense(COMPANY, 'e1', { date: '2026-10-10', amount: '11.00' }); // mirror row rewritten by a sync
  const l2 = await svc.listUnmatched('u1');
  expect(l2.state === 'ok' && l2.items.map((i) => i.expenseId)).toEqual(['e2']);
});

test('top 5 by amount desc; totals per currency; a PLN account with an EUR expense matches only an EUR document', async () => {
  for (let i = 1; i <= 6; i++) repo.seedExpense(COMPANY, `p${i}`, { amount: `${i * 10}.00`, date: '2026-10-10' });
  repo.seedExpense(COMPANY, 'eur', { amount: '99.00', currency: 'EUR', date: '2026-10-10' });
  findExpenses.mockResolvedValue([wfExp('w1', '2026-10-10', 99, 'PLN')]); // a PLN document must not match the EUR expense
  const r = await svc.getSummary('u1');
  if (r.state !== 'ok') throw new Error('expected ok');
  expect(r.unmatchedCount).toBe(7);
  expect(r.items).toHaveLength(5);
  expect(r.items[0]).toMatchObject({ expenseId: 'eur', amount: 99, currency: 'EUR' });
  expect(r.unmatchedTotals).toEqual([{ currency: 'EUR', total: 99 }, { currency: 'PLN', total: 210 }]);

  findExpenses.mockResolvedValue([wfExp('w2', '2026-10-10', 99, 'EUR')]);
  await redis.del('aib:recon:u1');
  const r2 = await svc.getSummary('u1');
  if (r2.state !== 'ok') throw new Error('expected ok');
  expect(r2.unmatchedTotals).toEqual([{ currency: 'PLN', total: 210 }]);
});

test('no wFirma credentials gives wfirma_not_connected; wFirma throwing gives wfirma_error, never ok with zero', async () => {
  factory.hasUserCredentials.mockResolvedValue(false);
  expect(await svc.getSummary('u1')).toEqual({ state: 'wfirma_not_connected' });
  factory.hasUserCredentials.mockResolvedValue(true);
  findExpenses.mockRejectedValue(new Error('boom'));
  expect(await svc.getSummary('u1')).toEqual({ state: 'wfirma_error' });
  expect(await redis.get('aib:recon:u1')).toBeNull();
});

test('result is cached 300 s under aib:recon:{userId} and dismiss clears it', async () => {
  repo.seedExpense(COMPANY, 'e1', { date: '2026-10-10' });
  await svc.getSummary('u1');
  await svc.getSummary('u1');
  expect(findExpenses).toHaveBeenCalledTimes(1);
  expect(RECON_CACHE_TTL_SECONDS).toBe(300);
  redis.advance(301_000);
  await svc.getSummary('u1');
  expect(findExpenses).toHaveBeenCalledTimes(2);
  await svc.dismiss('u1', 'e1', null);
  expect(await redis.get('aib:recon:u1')).toBeNull();
});

test('listUnmatched reports unknown states instead of an empty list', async () => {
  factory.hasUserCredentials.mockResolvedValue(false);
  expect(await svc.listUnmatched('u1')).toEqual({ state: 'wfirma_not_connected' });
  factory.hasUserCredentials.mockResolvedValue(true);
  findExpenses.mockRejectedValue(new Error('boom'));
  expect(await svc.listUnmatched('u1')).toEqual({ state: 'wfirma_error' });
  expect(await svc.listUnmatched('nobody')).toEqual({ state: 'no_company' });
  expect(await svc.getSummary('nobody')).toEqual({ state: 'no_company' });
});

test('a cached summary for company A is not served after the company changes to B', async () => {
  repo.seedExpense(COMPANY, 'e1', { date: '2026-10-10' });
  expect(await svc.getSummary('u1')).toMatchObject({ unmatchedCount: 1 });
  repo.accountRows.get(COMPANY)!.label = 'other_business';
  repo.seedAccount('u1', { externalId: 'b2', type: 'business', label: 'company' });
  expect(await svc.getSummary('u1')).toMatchObject({ state: 'ok', unmatchedCount: 0 });
});

test('dismiss refuses an unknown expense and a missing company; summary flags a truncated wFirma read', async () => {
  expect(await svc.dismiss('u1', 'nope', null)).toBe('not_found');
  expect(await svc.dismiss('nobody', 'e1', null)).toBe('no_company');
  findExpenses.mockResolvedValue(Array.from({ length: 1000 }, (_, i) => wfExp(`w${i}`, '2026-10-10', 5000 + i)));
  expect(await svc.getSummary('u1')).toMatchObject({ state: 'ok', truncated: true });
});
