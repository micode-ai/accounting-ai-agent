import { AiBudgetAccountsService } from '../ai-budget-accounts.service';
import type { AiBudgetApiClient } from '../ai-budget-api.client';
import { AiBudgetAccountNotFoundError, AiBudgetAccountUnavailableError, AiBudgetNotConnectedError } from '../ai-budget-errors';
import type { RemoteAccount } from '../ai-budget.types';
import { InMemoryAiBudgetRepository } from './fakes';

const remote = (id: string, type: string | null, over: Partial<RemoteAccount> = {}): RemoteAccount => ({
  id, name: id.toUpperCase(), type, base_currency: 'PLN', access: 'read', active: true, reason: null, ...over,
});

let repo: InMemoryAiBudgetRepository;
let listAccounts: jest.Mock;
let svc: AiBudgetAccountsService;
let listener: jest.Mock;

const labelsOf = async (): Promise<Record<string, string>> =>
  Object.fromEntries((await repo.listAccounts('u1')).map((a) => [a.externalId, a.label]));

beforeEach(() => {
  repo = new InMemoryAiBudgetRepository();
  repo.seedConnection('u1');
  listAccounts = jest.fn();
  svc = new AiBudgetAccountsService(repo, { listAccounts } as unknown as AiBudgetApiClient);
  listener = jest.fn();
  svc.setCompanyChangedListener(listener);
});

/** b1 company (2 mirror rows, 1 dismissal), b2 other_business, p private. */
function seedTwoBusiness(): void {
  repo.seedAccount('u1', { externalId: 'b1', type: 'business', label: 'company', labelSource: 'auto', syncCursor: 'c1', lastSyncedAt: new Date() });
  repo.seedAccount('u1', { externalId: 'b2', type: 'business', label: 'other_business' });
  repo.seedAccount('u1', { externalId: 'p', type: 'personal', label: 'private' });
  repo.seedExpense('b1-row', 'e1');
  repo.seedExpense('b1-row', 'e2');
  repo.seedDismissal('b1-row', 'e1');
}

test('first sync creates rows with automatic labels', async () => {
  listAccounts.mockResolvedValue([remote('b1', 'business'), remote('p', 'personal')]);
  const r = await svc.syncAccountList('u1');
  expect(await labelsOf()).toEqual({ b1: 'company', p: 'private' });
  expect(r.accounts.map((a) => a.labelSource)).toEqual(['auto', 'auto']);
  expect(r.needsCompanyChoice).toBe(false);
  expect(r.companyChanged).toBe(true);
});

test('several business accounts and no choice set needsCompanyChoice', async () => {
  listAccounts.mockResolvedValue([remote('b1', 'business'), remote('b2', 'business')]);
  const r = await svc.syncAccountList('u1');
  expect(await labelsOf()).toEqual({ b1: 'other_business', b2: 'other_business' });
  expect(r.needsCompanyChoice).toBe(true);
  expect((await repo.getConnection('u1'))!.needsCompanyChoice).toBe(true);
});

test('sync without a connection throws not connected', async () => {
  repo.connections.clear();
  await expect(svc.syncAccountList('u1')).rejects.toBeInstanceOf(AiBudgetNotConnectedError);
});

test('an account missing from /accounts is dropped with its mirror and dismissals', async () => {
  seedTwoBusiness();
  listAccounts.mockResolvedValue([remote('p', 'personal')]);
  const r = await svc.syncAccountList('u1');
  expect(r.dropped).toEqual(['b1', 'b2']);
  expect(repo.expenses('b1-row')).toHaveLength(0);
  expect(repo.dismissals('b1-row')).toHaveLength(0);
  expect(await labelsOf()).toEqual({ p: 'private' });
});

test('an inactive account keeps its mirror rows and stores the reason', async () => {
  seedTwoBusiness();
  listAccounts.mockResolvedValue([remote('b1', 'business', { active: false, reason: 'archived' }), remote('p', 'personal')]);
  await svc.syncAccountList('u1');
  const b1 = (await repo.listAccounts('u1')).find((a) => a.externalId === 'b1')!;
  expect(b1).toMatchObject({ active: false, inactiveReason: 'archived' });
  expect(repo.expenses('b1-row')).toHaveLength(2);
  expect(await svc.getCompanyAccount('u1')).toBeNull();
});

test('an inactive-but-visible company keeps the role and its mirror; another business account does not replace it', async () => {
  repo.seedAccount('u1', { externalId: 'b1', type: 'business', label: 'company', labelSource: 'auto' });
  repo.seedExpense('b1-row', 'e1');
  listAccounts.mockResolvedValue([remote('b1', 'business', { active: false, reason: 'archived' }), remote('b3', 'business')]);
  const r = await svc.syncAccountList('u1');
  expect(await labelsOf()).toEqual({ b1: 'company', b3: 'other_business' });
  expect(repo.expenses('b1-row')).toHaveLength(1);
  expect(r.needsCompanyChoice).toBe(false);
  expect(await svc.getCompanyAccount('u1')).toBeNull();
});

test('a manual company on an inactive account is kept', async () => {
  repo.seedAccount('u1', { externalId: 'b1', type: 'business', label: 'company', labelSource: 'manual' });
  repo.seedExpense('b1-row', 'e1');
  listAccounts.mockResolvedValue([remote('b1', 'business', { active: false, reason: 'role' }), remote('b3', 'business')]);
  await svc.syncAccountList('u1');
  expect((await repo.listAccounts('u1')).find((a) => a.externalId === 'b1')).toMatchObject({ label: 'company', labelSource: 'manual', active: false });
  expect(repo.expenses('b1-row')).toHaveLength(1);
});

test('an unavailable company loses the label and its mirror is cleared', async () => {
  repo.seedAccount('u1', { externalId: 'b1', type: 'business', label: 'company', labelSource: 'auto' });
  repo.seedExpense('b1-row', 'e1');
  listAccounts.mockResolvedValue([remote('b1', null, { name: null, base_currency: null, active: false, reason: 'role' }), remote('b3', 'business')]);
  await svc.syncAccountList('u1');
  expect(await labelsOf()).toEqual({ b1: 'private', b3: 'company' });
  expect(repo.expenses('b1-row')).toHaveLength(0);
});

test('an account with a null name is unavailable, never company, with no placeholder name', async () => {
  listAccounts.mockResolvedValue([remote('b1', 'business', { name: null, type: null, base_currency: null, active: false, reason: 'role' })]);
  await svc.syncAccountList('u1');
  const row = (await repo.listAccounts('u1'))[0];
  expect(row).toMatchObject({ name: '', type: '', active: false, inactiveReason: 'role', label: 'private' });
  expect(await svc.getCompanyAccount('u1')).toBeNull();
});

test('a null name on an account reported active is still treated as inactive', async () => {
  listAccounts.mockResolvedValue([remote('b1', 'business', { name: null })]);
  await svc.syncAccountList('u1');
  expect((await repo.listAccounts('u1'))[0]).toMatchObject({ active: false, label: 'private' });
});

test('reconnect keeps manual labels of still-granted accounts', async () => {
  repo.seedAccount('u1', { externalId: 'p', type: 'personal', label: 'other_business', labelSource: 'manual' });
  listAccounts.mockResolvedValue([remote('p', 'personal')]);
  await svc.syncAccountList('u1');
  expect(await labelsOf()).toEqual({ p: 'other_business' });
});

test('relabelling the company account away deletes its mirror, cursor and dismissals at once', async () => {
  seedTwoBusiness();
  await svc.setLabel('u1', 'b1-row', 'private');
  const row = (await repo.listAccounts('u1')).find((a) => a.id === 'b1-row')!;
  expect(row).toMatchObject({ label: 'private', labelSource: 'manual', syncCursor: null, lastSyncedAt: null });
  expect(repo.expenses('b1-row')).toHaveLength(0);
  expect(repo.dismissals('b1-row')).toHaveLength(0);
  expect(listener).toHaveBeenCalledWith('u1');
});

test('choosing a new company demotes the old one, clears its mirror and fires the listener', async () => {
  seedTwoBusiness();
  await svc.setLabel('u1', 'b2-row', 'company');
  expect(await labelsOf()).toEqual({ b1: 'other_business', b2: 'company', p: 'private' });
  expect(listener).toHaveBeenCalledWith('u1');
  expect(repo.expenses('b1-row')).toHaveLength(0);
});

test('choosing a company clears needsCompanyChoice', async () => {
  repo.seedConnection('u1', { needsCompanyChoice: true });
  repo.seedAccount('u1', { externalId: 'b1', type: 'business', label: 'other_business' });
  repo.seedAccount('u1', { externalId: 'b2', type: 'business', label: 'other_business' });
  await svc.setLabel('u1', 'b2-row', 'company');
  expect((await repo.getConnection('u1'))!.needsCompanyChoice).toBe(false);
});

test('an inactive account cannot be chosen as the company', async () => {
  repo.seedAccount('u1', { externalId: 'b1', type: 'business', label: 'other_business', active: false });
  await expect(svc.setLabel('u1', 'b1-row', 'company')).rejects.toBeInstanceOf(AiBudgetAccountUnavailableError);
});

test('setLabel on an unknown row or another user is refused', async () => {
  repo.seedAccount('u2', { externalId: 'x' });
  await expect(svc.setLabel('u1', 'x-row', 'private')).rejects.toBeInstanceOf(AiBudgetAccountNotFoundError);
});

test('getCompanyAccount returns the active company only', async () => {
  seedTwoBusiness();
  expect((await svc.getCompanyAccount('u1'))!.externalId).toBe('b1');
});

test('handleAccessError(account_not_granted) re-syncs the account list and drops the account', async () => {
  seedTwoBusiness();
  listAccounts.mockResolvedValue([remote('p', 'personal'), remote('b2', 'business')]);
  await svc.handleAccessError('u1', 'b1', 'account_not_granted');
  expect(listAccounts).toHaveBeenCalledTimes(1);
  expect(repo.expenses('b1-row')).toHaveLength(0);
  expect(repo.dismissals('b1-row')).toHaveLength(0);
  expect(await labelsOf()).toEqual({ b2: 'company', p: 'private' });
});

test('handleAccessError(grant_inactive) marks the account inactive without re-syncing', async () => {
  seedTwoBusiness();
  await svc.handleAccessError('u1', 'b1', 'grant_inactive');
  expect(listAccounts).not.toHaveBeenCalled();
  expect((await repo.listAccounts('u1')).find((a) => a.externalId === 'b1')).toMatchObject({ active: false, inactiveReason: 'grant_inactive' });
  expect(await svc.getCompanyAccount('u1')).toBeNull();
});

test('handleAccessError(account_encrypted) neither drops nor deactivates the account', async () => {
  seedTwoBusiness();
  await svc.handleAccessError('u1', 'b1', 'account_encrypted');
  expect(listAccounts).not.toHaveBeenCalled();
  expect((await repo.listAccounts('u1')).find((a) => a.externalId === 'b1')).toMatchObject({ active: true, label: 'company' });
  expect(repo.expenses('b1-row')).toHaveLength(2);
});

test('handleAccessError ignores unknown codes and unknown accounts', async () => {
  seedTwoBusiness();
  await svc.handleAccessError('u1', 'b1', 'something_else');
  await svc.handleAccessError('u1', 'nope', 'grant_inactive');
  expect(listAccounts).not.toHaveBeenCalled();
});

test('the account-ids handler re-syncs only when the list differs from the stored one', async () => {
  seedTwoBusiness();
  listAccounts.mockResolvedValue([remote('b1', 'business'), remote('b2', 'business'), remote('p', 'personal')]);
  await svc.handleAccountIds('u1', ['p', 'b2', 'b1']);
  expect(listAccounts).not.toHaveBeenCalled();
  await svc.handleAccountIds('u1', ['b1', 'p']);
  expect(listAccounts).toHaveBeenCalledTimes(1);
});

test('the company-changed listener fires when a sync changes the company', async () => {
  seedTwoBusiness();
  listAccounts.mockResolvedValue([remote('p', 'personal'), remote('b2', 'business')]);
  await svc.syncAccountList('u1');
  expect(listener).toHaveBeenCalledWith('u1');
});

test('an unchanged sync does not fire the company-changed listener', async () => {
  seedTwoBusiness();
  listAccounts.mockResolvedValue([remote('b1', 'business'), remote('b2', 'business'), remote('p', 'personal')]);
  const r = await svc.syncAccountList('u1');
  expect(r.companyChanged).toBe(false);
  expect(listener).not.toHaveBeenCalled();
});

test('relabelling an account invalidates its live-read cache, and the demoted company too', async () => {
  seedTwoBusiness();
  const invalidate = jest.fn().mockResolvedValue(undefined);
  const withLive = new AiBudgetAccountsService(repo, { listAccounts } as unknown as AiBudgetApiClient, { invalidate });
  await withLive.setLabel('u1', 'b2-row', 'company');
  expect(invalidate).toHaveBeenCalledWith('u1', 'b2-row');
  expect(invalidate).toHaveBeenCalledWith('u1', 'b1-row');
});
