import type { StructuredToolInterface } from '@langchain/core/tools';
import { AiBudgetAccountsService } from '../../ai-budget/ai-budget-accounts.service';
import { AiBudgetApiError } from '../../ai-budget/ai-budget-errors';
import { AiBudgetWriteRefused, type ExpenseView } from '../../ai-budget/ai-budget-expenses.service';
import { AiBudgetChatFactory } from '../../ai-budget/ai-budget-chat.factory';
import { InMemoryAiBudgetRepository } from '../../ai-budget/__tests__/fakes';
import { AI_BUDGET_TOOL_PREFIX, createAiBudgetTools, isAiBudgetTool, type AiBudgetToolContext, type AiBudgetToolScope } from '../tools/ai-budget.tools';
import { SHARED_FRAGMENTS } from '../prompt-fragments';

const NOW = new Date('2026-11-02T12:00:00Z');
const view = (over: Partial<ExpenseView> = {}): ExpenseView => ({
  id: 'e1', accountExternalId: 'b1', accountName: 'Firma A', label: 'company', date: '2026-11-01', amountCents: 10000, currency: 'PLN',
  categoryId: null, categorySplits: [], merchant: 'Biedronka', description: null, isDebt: false, isSplitReceivable: false, ...over,
});
const emptyResult = { expenses: [] as ExpenseView[], truncated: false, companyAsOf: new Date('2026-11-02T11:00:00Z'), companyPending: false, companySyncFailed: false, failed: [], searchLimited: [] };

let repo: InMemoryAiBudgetRepository;
let expenses: {
  query: jest.Mock; create: jest.Mock; update: jest.Mock; remove: jest.Mock; listCategories: jest.Mock; ensureCompanyFresh: jest.Mock;
};
let reconciliation: { listUnmatched: jest.Mock };
let onNonCompanyData: jest.Mock;

beforeEach(() => {
  repo = new InMemoryAiBudgetRepository();
  repo.seedConnection('u1');
  repo.seedAccount('u1', { externalId: 'b1', name: 'Firma A', type: 'business', label: 'company', access: 'read_write', lastSyncedAt: new Date('2026-11-02T11:00:00Z') });
  repo.seedAccount('u1', { externalId: 'p', name: 'Personal', type: 'personal', label: 'private', access: 'read_write' });
  repo.seedAccount('u1', { externalId: 'ro', name: 'Joint', type: 'shared', label: 'private', access: 'read' });
  expenses = {
    query: jest.fn().mockResolvedValue(emptyResult),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn().mockResolvedValue(undefined),
    listCategories: jest.fn().mockResolvedValue([{ id: 'c-food', name: 'Food', type: 'expense' }]),
    ensureCompanyFresh: jest.fn(async () => ({ company: (await repo.listAccounts('u1')).find((a) => a.label === 'company') ?? null, pending: false })),
  };
  reconciliation = { listUnmatched: jest.fn().mockResolvedValue({ state: 'ok', items: [], truncated: false }) };
  onNonCompanyData = jest.fn();
});

function tools(scope: AiBudgetToolScope = 'all', connectionStatus: 'active' | 'needs_reconnect' = 'active'): Record<string, StructuredToolInterface> {
  const ctx: AiBudgetToolContext = {
    userId: 'u1', locale: 'en', scope, connectionStatus, expenses: expenses as never, accounts: new AiBudgetAccountsService(repo, {} as never),
    reconciliation: reconciliation as never, repo, onNonCompanyData, now: () => NOW,
  };
  return Object.fromEntries(createAiBudgetTools(ctx).map((t) => [t.name, t]));
}
const run = async (t: StructuredToolInterface, args: Record<string, unknown>): Promise<string> => String(await t.invoke(args));

test('tool names carry the prefix', () => {
  expect(Object.keys(tools()).sort()).toEqual([
    'ai_budget_create_expense', 'ai_budget_delete_expense', 'ai_budget_expenses_without_document', 'ai_budget_get_expenses',
    'ai_budget_list_accounts', 'ai_budget_spending_summary', 'ai_budget_update_expense',
  ]);
  expect(AI_BUDGET_TOOL_PREFIX).toBe('ai_budget_');
  expect(isAiBudgetTool('ai_budget_get_expenses')).toBe(true);
  expect(isAiBudgetTool('get_expenses')).toBe(false);
});

test('company_only scope: list_accounts shows only the company account', async () => {
  const out = await run(tools('company_only').ai_budget_list_accounts, {});
  expect(out).toContain('Firma A');
  expect(out).toContain('**[Company]**');
  expect(out).not.toContain('Personal');
  expect(out).not.toContain('Joint');
  expect(out).toContain('only the company account is available');
  expect(onNonCompanyData).not.toHaveBeenCalled();
});

test('list_accounts shows an unavailable account as unavailable, an inactive one as inactive', async () => {
  repo.seedAccount('u1', { externalId: 'gone', name: '', type: '', label: 'private', active: false, inactiveReason: 'role' });
  repo.seedAccount('u1', { externalId: 'arch', name: 'Archived', type: 'personal', label: 'private', active: false, inactiveReason: 'archived' });
  const out = await run(tools().ai_budget_list_accounts, {});
  expect(out).toMatch(/Account no longer available · `gone`[^\n]*unavailable/);
  expect(out).not.toMatch(/`gone`[^\n]*inactive/);
  expect(out).toMatch(/Archived · `arch`[^\n]*inactive/);
});

test('all scope: list_accounts lists every account, labelled, in label order, with access', async () => {
  repo.seedAccount('u1', { externalId: 'ob', name: 'Side gig', type: 'business', label: 'other_business', access: 'read_write' });
  const out = await run(tools().ai_budget_list_accounts, {});
  const iCompany = out.indexOf('**[Company]** Firma A');
  const iOther = out.indexOf('**[Other business]** Side gig');
  const iPrivate = out.indexOf('**[Private]** Personal');
  expect(iCompany).toBeGreaterThanOrEqual(0);
  expect(iOther).toBeGreaterThan(iCompany);
  expect(iPrivate).toBeGreaterThan(iOther);
  expect(out).toMatch(/Joint.*read-only/);
  expect(out).toContain('`b1`');
  expect(onNonCompanyData).toHaveBeenCalled();
});

test('company_only scope: get_expenses for a private account id refuses and reads nothing', async () => {
  const t = tools('company_only');
  const out = await run(t.ai_budget_get_expenses, { accountId: 'p' });
  expect(out).toContain('only the company account is available');
  const out2 = await run(t.ai_budget_get_expenses, { label: 'private' });
  expect(out2).toContain('only the company account is available');
  expect(expenses.query).not.toHaveBeenCalled();
  expect(onNonCompanyData).not.toHaveBeenCalled();
});

test('company_only scope: get_expenses without filters reads only the company account', async () => {
  await run(tools('company_only').ai_budget_get_expenses, {});
  const q = expenses.query.mock.calls[0][1];
  expect(q.accounts.map((a: { externalId: string }) => a.externalId)).toEqual(['b1']);
  expect(q).toMatchObject({ dateFrom: '2026-11-01', dateTo: '2026-11-30' });
});

test('company_only scope: create on a private account refuses', async () => {
  const out = await run(tools('company_only').ai_budget_create_expense, { accountId: 'p', amount: '10', date: '2026-11-01' });
  expect(out).toContain('only the company account is available');
  expect(expenses.create).not.toHaveBeenCalled();
});

test('company_only scope: a company write is passed down with companyOnly', async () => {
  expenses.create.mockResolvedValue(view({ id: 'n1' }));
  await run(tools('company_only').ai_budget_create_expense, { accountId: 'b1', amount: '10', date: '2026-11-01' });
  expect(expenses.create).toHaveBeenCalledWith('u1', 'b1-row', { amount: '10', date: '2026-11-01' }, { companyOnly: true });
});

test('get_expenses: totals are per label and per currency; no line sums company and private', async () => {
  expenses.query.mockResolvedValue({
    ...emptyResult,
    expenses: [
      view({ id: 'c1', amountCents: 10000 }),
      view({ id: 'p1', accountExternalId: 'p', accountName: 'Personal', label: 'private', amountCents: 4000, merchant: 'Kino' }),
      view({ id: 'c2', amountCents: 500, currency: 'EUR' }),
    ],
  });
  const out = await run(tools().ai_budget_get_expenses, {});
  expect(out).toMatch(/\*\*\[Company\]\*\*[^\n]*100\.00 PLN/);
  expect(out).toMatch(/\*\*\[Company\]\*\*[^\n]*5\.00 EUR/);
  expect(out).toMatch(/\*\*\[Private\]\*\*[^\n]*40\.00 PLN/);
  expect(out).not.toContain('140.00');
  expect(out).not.toContain('105.00');
  for (const line of out.split('\n').filter((l) => /\d+\.\d\d [A-Z]{3}/.test(l))) expect(line).toMatch(/^(#+ |- )?\*\*\[(Company|Other business|Private)\]\*\*/);
  expect(out.indexOf('**[Company]**')).toBeLessThan(out.indexOf('**[Private]**'));
});

test('get_expenses excludes debts and split receivables from totals; includeNonSpending lists them labelled', async () => {
  expenses.query.mockResolvedValue({
    ...emptyResult,
    expenses: [
      view({ id: 'c1', amountCents: 10000 }),
      view({ id: 'd1', amountCents: 7000, isDebt: true }),
      view({ id: 's1', amountCents: 300, isSplitReceivable: true }),
    ],
  });
  const plain = await run(tools().ai_budget_get_expenses, {});
  expect(plain).not.toContain('70.00');
  expect(plain).not.toContain('`d1`');
  expect(plain).not.toContain('173.00');

  const full = await run(tools().ai_budget_get_expenses, { includeNonSpending: true });
  expect(full).toMatch(/70\.00 PLN[^\n]*money lent \(not spending\)/);
  expect(full).toMatch(/3\.00 PLN[^\n]*bill share owed back \(not spending\)/);
  expect(full).toContain('Not spending (excluded from totals)');
  expect(full).not.toContain('173.00');
  expect(full).toMatch(/Totals by currency[\s\S]*\*\*\[Company\]\*\* 100\.00 PLN/);
});

test('get_expenses: limit caps the listed rows, not the totals', async () => {
  expenses.query.mockResolvedValue({
    ...emptyResult,
    expenses: [view({ id: 'a', amountCents: 100, date: '2026-11-03' }), view({ id: 'b', amountCents: 200, date: '2026-11-02' }), view({ id: 'c', amountCents: 300 })],
  });
  const out = await run(tools().ai_budget_get_expenses, { limit: 2 });
  expect(out).toContain('`a`');
  expect(out).toContain('`b`');
  expect(out).not.toContain('`c`');
  expect(out).toContain('6.00 PLN');
  expect(out).toContain('Showing 2 of 3 expenses.');
});

test('a write tool requires accountId (schema) and reports the target account and label in its result', async () => {
  const t = tools();
  await expect(t.ai_budget_create_expense.invoke({ amount: '10', date: '2026-11-01' })).rejects.toThrow();
  await expect(t.ai_budget_create_expense.invoke({ accountId: 'p', amount: '10.123', date: '2026-11-01' })).rejects.toThrow();
  await expect(t.ai_budget_create_expense.invoke({ accountId: 'p', amount: '10', date: '1.11.2026' })).rejects.toThrow();
  await expect(t.ai_budget_delete_expense.invoke({ expenseId: 'e1' })).rejects.toThrow();
  expect(expenses.create).not.toHaveBeenCalled();

  expenses.create.mockResolvedValue(view({ id: 'n1', accountExternalId: 'p', accountName: 'Personal', label: 'private', amountCents: 1050 }));
  const out = await run(t.ai_budget_create_expense, { accountId: 'p', amount: '10.5', date: '2026-11-01', categoryName: 'Food' });
  expect(expenses.create).toHaveBeenCalledWith('u1', 'p-row', { amount: '10.5', date: '2026-11-01', categoryName: 'Food' }, { companyOnly: false });
  expect(out).toContain('Created in AI Budget');
  expect(out).toContain('**[Private]**');
  expect(out).toContain('Personal');
  expect(out).toContain('10.50 PLN');
  expect(out).toContain('`n1`');
});

test('write refusals and API errors come back as localized text, never thrown', async () => {
  const t = tools();
  expect(await run(t.ai_budget_create_expense, { accountId: 'ro', amount: '1', date: '2026-11-01' })).toContain('read-only in AI Budget');
  expect(expenses.create).not.toHaveBeenCalled();
  expect(await run(t.ai_budget_create_expense, { accountId: 'zzz', amount: '1', date: '2026-11-01' })).toContain('Account no longer available');

  expenses.create.mockRejectedValueOnce(new AiBudgetWriteRefused('unknown_category', ['Food', 'Fuel']));
  expect(await run(t.ai_budget_create_expense, { accountId: 'p', amount: '1', date: '2026-11-01', categoryName: 'Taxes' }))
    .toContain('Category "Taxes" not found. Available: Food, Fuel');
  expenses.update.mockRejectedValueOnce(new AiBudgetApiError(403, 'account_encrypted'));
  expect(await run(t.ai_budget_update_expense, { accountId: 'p', expenseId: 'e1', amount: '2' })).toContain('encrypted in AI Budget');
  expenses.remove.mockRejectedValueOnce(new AiBudgetApiError(404, 'not_found'));
  expect(await run(t.ai_budget_delete_expense, { accountId: 'p', expenseId: 'e1' })).toContain('not found');
  expenses.remove.mockRejectedValueOnce(new AiBudgetApiError(503, 'http_503'));
  expect(await run(t.ai_budget_delete_expense, { accountId: 'p', expenseId: 'e1' })).toContain('http_503');
  expect(await run(t.ai_budget_update_expense, { accountId: 'p', expenseId: 'e1' })).toContain('No field to change');
});

test('inactive accounts are refused, never read', async () => {
  repo.seedAccount('u1', { externalId: 'off', name: 'Old', label: 'private', active: false, inactiveReason: 'archived' });
  const out = await run(tools().ai_budget_get_expenses, { accountId: 'off' });
  expect(out).toContain('currently unavailable');
  expect(expenses.query).not.toHaveBeenCalled();
});

test('update passes clearable fields through as null and delete names the target', async () => {
  expenses.update.mockResolvedValue(view({ merchant: null }));
  const out = await run(tools().ai_budget_update_expense, { accountId: 'b1', expenseId: 'e1', merchant: null, amount: '100' });
  expect(expenses.update).toHaveBeenCalledWith('u1', 'b1-row', 'e1', { merchant: null, amount: '100' }, { companyOnly: false });
  expect(out).toContain('Updated in AI Budget');
  expect(out).toContain('**[Company]**');
  const del = await run(tools().ai_budget_delete_expense, { accountId: 'b1', expenseId: 'e1' });
  expect(expenses.remove).toHaveBeenCalledWith('u1', 'b1-row', 'e1', { companyOnly: false });
  expect(del).toContain('Deleted in AI Budget');
  expect(del).toContain('**[Company]** Firma A');
  expect(del).toContain('`e1`');
});

test('reading non-company data calls onNonCompanyData; company-only reads do not', async () => {
  await run(tools().ai_budget_get_expenses, { label: 'company' });
  await run(tools().ai_budget_spending_summary, { accountId: 'b1', dateFrom: '2026-10-01', dateTo: '2026-11-30', groupBy: 'month' });
  await run(tools().ai_budget_expenses_without_document, {});
  expect(onNonCompanyData).not.toHaveBeenCalled();
  await run(tools().ai_budget_get_expenses, { accountId: 'p' });
  expect(onNonCompanyData).toHaveBeenCalledTimes(1);
  expenses.create.mockResolvedValue(view({ label: 'private', accountExternalId: 'p', accountName: 'Personal' }));
  await run(tools().ai_budget_create_expense, { accountId: 'p', amount: '1', date: '2026-11-01' });
  expect(onNonCompanyData).toHaveBeenCalledTimes(2);
});

test('spending_summary by category and by month, per label, splits decide', async () => {
  expenses.query.mockResolvedValue({
    ...emptyResult,
    expenses: [
      view({ id: 'c1', amountCents: 10000, categoryId: 'c-food', date: '2026-11-01' }),
      view({ id: 'c2', amountCents: 5000, categoryId: 'c-fuel', categorySplits: [{ categoryId: 'c-food', amountCents: 2000 }, { categoryId: null, amountCents: 3000 }], date: '2026-10-05' }),
      view({ id: 'd', amountCents: 99900, isDebt: true }),
      view({ id: 'p1', accountExternalId: 'p', accountName: 'Personal', label: 'private', amountCents: 4000, categoryId: 'c-food' }),
    ],
  });
  const byCat = await run(tools().ai_budget_spending_summary, { dateFrom: '2026-10-01', dateTo: '2026-11-30', groupBy: 'category' });
  expect(byCat).toMatch(/\*\*\[Company\]\*\* Food: 120\.00 PLN/);
  expect(byCat).toMatch(/\*\*\[Company\]\*\* Uncategorized: 30\.00 PLN/);
  expect(byCat).toMatch(/\*\*\[Private\]\*\* Food: 40\.00 PLN/);
  expect(byCat).not.toContain('160.00');
  expect(byCat).not.toContain('999.00');
  const byMonth = await run(tools().ai_budget_spending_summary, { dateFrom: '2026-10-01', dateTo: '2026-11-30', groupBy: 'month' });
  expect(byMonth).toMatch(/\*\*\[Company\]\*\* 2026-10: 50\.00 PLN/);
  expect(byMonth).toMatch(/\*\*\[Company\]\*\* 2026-11: 100\.00 PLN/);
  expect(byMonth).toMatch(/\*\*\[Private\]\*\* 2026-11: 40\.00 PLN/);
});

test('a company that has not synced yet is reported as syncing, never as zero', async () => {
  expenses.query.mockResolvedValue({ ...emptyResult, companyAsOf: null, companyPending: true });
  const out = await run(tools().ai_budget_get_expenses, { label: 'company' });
  expect(out).toContain('still syncing');
  expect(out).not.toMatch(/0\.00/);
});

test('an account that could not be read is reported as unknown', async () => {
  expenses.query.mockResolvedValue({ ...emptyResult, failed: [{ accountExternalId: 'p', code: 'http_503' }] });
  const out = await run(tools().ai_budget_get_expenses, {});
  expect(out).toContain('"Personal" could not be read');
});

test('needs_reconnect: every tool returns the reconnect message', async () => {
  const t = tools('all', 'needs_reconnect');
  const args: Record<string, Record<string, unknown>> = {
    ai_budget_list_accounts: {}, ai_budget_get_expenses: {}, ai_budget_expenses_without_document: {},
    ai_budget_spending_summary: { dateFrom: '2026-11-01', dateTo: '2026-11-30', groupBy: 'month' },
    ai_budget_create_expense: { accountId: 'b1', amount: '1', date: '2026-11-01' },
    ai_budget_update_expense: { accountId: 'b1', expenseId: 'e1', amount: '1' },
    ai_budget_delete_expense: { accountId: 'b1', expenseId: 'e1' },
  };
  for (const [name, a] of Object.entries(args)) {
    expect(await run(t[name], a)).toBe('Connection to AI Budget lost — reconnect it in Settings → Integrations.');
  }
  expect(expenses.query).not.toHaveBeenCalled();
  expect(reconciliation.listUnmatched).not.toHaveBeenCalled();
});

test('expenses_without_document uses "No matching document found" wording', async () => {
  reconciliation.listUnmatched.mockResolvedValue({
    state: 'ok', truncated: false, items: [{ expenseId: 'x1', date: '2026-10-03', amount: 123.4, currency: 'PLN', merchant: 'Orlen' }],
  });
  const out = await run(tools().ai_budget_expenses_without_document, {});
  expect(out).toContain('No matching document found');
  expect(out).not.toMatch(/no invoice/i);
  expect(out).toMatch(/\*\*\[Company\]\*\* 2026-10-03[^\n]*123\.40 PLN[^\n]*Orlen/);
});

test('expenses_without_document: unknown states are never "all matched"', async () => {
  const t = tools();
  reconciliation.listUnmatched.mockResolvedValueOnce({ state: 'wfirma_not_connected' });
  expect(await run(t.ai_budget_expenses_without_document, {})).toContain('Connect wFirma');
  reconciliation.listUnmatched.mockResolvedValueOnce({ state: 'wfirma_error' });
  const err = await run(t.ai_budget_expenses_without_document, {});
  expect(err).toContain('unknown which expenses');
  expect(err).not.toContain('Every company expense');
  reconciliation.listUnmatched.mockResolvedValueOnce({ state: 'no_company' });
  expect(await run(t.ai_budget_expenses_without_document, {})).toContain('No company account');
  reconciliation.listUnmatched.mockResolvedValueOnce({ state: 'ok', items: [], truncated: false });
  expect(await run(t.ai_budget_expenses_without_document, {})).toContain('Every company expense');

  expenses.ensureCompanyFresh.mockResolvedValueOnce({ company: { ...(await repo.listAccounts('u1'))[0], lastSyncedAt: null }, pending: true });
  const syncing = await run(t.ai_budget_expenses_without_document, {});
  expect(syncing).toContain('still syncing');
  expect(reconciliation.listUnmatched).toHaveBeenCalledTimes(4);
});

test('encrypted (null) merchant renders as "—", never "null"', async () => {
  expenses.query.mockResolvedValue({ ...emptyResult, expenses: [view({ merchant: null, description: null })] });
  const out = await run(tools().ai_budget_get_expenses, {});
  expect(out).toContain('—');
  expect(out).not.toContain('null');
  reconciliation.listUnmatched.mockResolvedValue({ state: 'ok', truncated: false, items: [{ expenseId: 'x', date: '2026-11-01', amount: 1, currency: 'PLN', merchant: null }] });
  const recon = await run(tools().ai_budget_expenses_without_document, {});
  expect(recon).not.toContain('null');
  expect(recon).toContain('—');
});

test('factory returns null without a connection and company_only scope for shared conversations', async () => {
  const services = { repo, accounts: new AiBudgetAccountsService(repo, {} as never), reconciliation, sync: { syncIfStale: jest.fn() }, live: {}, api: {} } as never;
  expect(await new AiBudgetChatFactory(null).forRun('u1', 'en', { isShared: false })).toBeNull();
  const f = new AiBudgetChatFactory(services);
  expect(await f.forRun('nobody', 'en', { isShared: false })).toBeNull();

  const shared = await f.forRun('u1', 'en', { isShared: true });
  expect(shared).not.toBeNull();
  expect(shared!.promptFragment).toContain('## AI Budget rules');
  expect(shared!.promptFragment).toContain('only the company account is available');
  const listed = String(await shared!.tools.find((t) => t.name === 'ai_budget_list_accounts')!.invoke({}));
  expect(listed).not.toContain('Personal');
  expect(shared!.nonCompanyDataUsed()).toBe(false);

  const own = await f.forRun('u1', 'en', { isShared: false });
  expect(own!.promptFragment).not.toContain('only the company account is available');
  await own!.tools.find((t) => t.name === 'ai_budget_list_accounts')!.invoke({});
  expect(own!.nonCompanyDataUsed()).toBe(true);

  await repo.setConnectionStatus('u1', 'needs_reconnect', NOW);
  const lost = await f.forRun('u1', 'en', { isShared: false });
  expect(lost!.promptFragment).toContain('The AI Budget connection is lost');
  expect(String(await lost!.tools[0].invoke({}))).toContain('reconnect');

  await repo.clearTokens('u1');
  expect(await f.forRun('u1', 'en', { isShared: false })).toBeNull();
});

test('aiBudgetRules: fixed copy, with the scope and reconnect lines only when they apply', () => {
  const base = SHARED_FRAGMENTS.aiBudgetRules('all', 'active');
  expect(base.split('\n')[0]).toBe('## AI Budget rules');
  expect(base).toContain('- Read-only accounts cannot be changed; explain this instead of writing.');
  expect(base).not.toContain('shared with the organization');
  expect(base).not.toContain('connection is lost');
  const both = SHARED_FRAGMENTS.aiBudgetRules('company_only', 'needs_reconnect');
  expect(both.split('\n')[1]).toContain('shared with the organization');
  expect(both.split('\n')[2]).toContain('connection is lost');
});

test('a category filter totals only the attributed share', async () => {
  expenses.query.mockResolvedValue({ ...emptyResult, expenses: [view({ id: 'b', amountCents: 5000, matchedCents: 500 }), view({ id: 'a', amountCents: 1000, matchedCents: 1000 })] });
  const out = await run(tools().ai_budget_get_expenses, { categoryName: 'Food', label: 'company' });
  expect(expenses.query.mock.calls[0][1]).toMatchObject({ categoryName: 'Food' });
  expect(out).toMatch(/Totals by currency\n\*\*\[Company\]\*\* 15\.00 PLN/);
  expect(out).not.toContain('60.00');
  expect(out).toContain('5.00 PLN (50.00 PLN)');
});

test('the expenses tool filters by category name, not by an id the model never sees', () => {
  const schema = tools().ai_budget_get_expenses.schema as unknown as { shape: Record<string, unknown> };
  expect(schema.shape).toHaveProperty('categoryName');
  expect(schema.shape).not.toHaveProperty('categoryId');
});

test('an unknown category name lists the available names instead of "no expenses"', async () => {
  expenses.query.mockResolvedValue({ ...emptyResult, unknownCategory: ['Food', 'Fuel'] });
  const out = await run(tools().ai_budget_get_expenses, { categoryName: 'Travel' });
  expect(out).toBe('Category "Travel" not found. Available: Food, Fuel');
});

test('a failed first company sync is reported as sync failed, never as syncing', async () => {
  expenses.query.mockResolvedValue({ ...emptyResult, companyAsOf: null, companyPending: false, companySyncFailed: true });
  const out = await run(tools().ai_budget_get_expenses, { label: 'company' });
  expect(out).toContain('could not be synced yet');
  expect(out).not.toContain('still syncing');
  expenses.ensureCompanyFresh.mockResolvedValueOnce({ company: { ...(await repo.listAccounts('u1'))[0], lastSyncedAt: null }, pending: false, syncFailed: true });
  expect(await run(tools().ai_budget_expenses_without_document, {})).toContain('could not be synced yet');
  expect(reconciliation.listUnmatched).not.toHaveBeenCalled();
});

test('a total from a partly read label is tagged incomplete', async () => {
  repo.seedAccount('u1', { externalId: 'p2', name: 'Second', type: 'personal', label: 'private', access: 'read' });
  expenses.query.mockResolvedValue({
    ...emptyResult,
    expenses: [view({ id: 'p1', accountExternalId: 'p', accountName: 'Personal', label: 'private', amountCents: 4000 }), view({ id: 'c1' })],
    failed: [{ accountExternalId: 'p2', code: 'http_503' }],
  });
  const out = await run(tools().ai_budget_get_expenses, {});
  expect(out).toMatch(/\*\*\[Private\]\*\* 40\.00 PLN \(incomplete/);
  expect(out).toMatch(/\*\*\[Company\]\*\* 100\.00 PLN\n/);
});

test('a label filter with no account says so, not "no expenses"', async () => {
  const out = await run(tools().ai_budget_get_expenses, { label: 'other_business' });
  expect(out).toBe('No connected AI Budget account has the label "Other business".');
  expect(expenses.query).not.toHaveBeenCalled();
});

test('the unmatched totals line starts with the label prefix', async () => {
  reconciliation.listUnmatched.mockResolvedValue({ state: 'ok', truncated: false, items: [{ expenseId: 'x', date: '2026-11-01', amount: 12.5, currency: 'PLN', merchant: 'A' }] });
  const out = await run(tools().ai_budget_expenses_without_document, {});
  const totals = out.split('\n').find((l) => l.includes('Totals by currency'))!;
  expect(totals.startsWith('**[Company]**')).toBe(true);
  expect(totals).toContain('12.50 PLN');
});

test('a write tool\'s unknown-category message never carries a category name verbatim (injected markdown)', async () => {
  const evil = '![x](https://evil.tld/?d=1)';
  expenses.create.mockRejectedValue(new AiBudgetWriteRefused('unknown_category', [evil, 'Food']));
  const out = await run(tools().ai_budget_create_expense, { accountId: 'p', amount: '10', date: '2026-11-01', categoryName: '[go](https://evil.tld/n)' });
  expect(out).not.toContain(evil);
  expect(out).not.toContain('](');
  expect(out).not.toContain('https://');
  expect(out).toContain('Food');
  expenses.update.mockRejectedValue(new AiBudgetWriteRefused('unknown_category', [evil]));
  const upd = await run(tools().ai_budget_update_expense, { accountId: 'p', expenseId: 'e1', categoryName: 'X' });
  expect(upd).not.toContain(evil);
  expect(upd).not.toContain('https://');
});
