import { AiBudgetConfig } from '../ai-budget.config';
import { AiBudgetApiClient } from '../ai-budget-api.client';
import { AiBudgetApiError } from '../ai-budget-errors';
import { AiBudgetTokenManager } from '../ai-budget-token.manager';
import { FakeTransport } from './fakes';

const config: AiBudgetConfig = {
  clientId: 'cid', clientSecret: 'csecret', apiUrl: 'https://api.ai-budget.pl', authorizeUrl: 'https://app.ai-budget.pl/authorize',
  tokenUrl: 'https://api.ai-budget.pl/oauth/token', revokeUrl: 'https://api.ai-budget.pl/oauth/revoke',
  redirectUri: 'https://api.eksiegowyai.pl/api/integrations/ai-budget/callback', frontendUrl: 'https://eksiegowyai.pl',
};

const expense = { id: 'e1', amount: '45.00', currency: 'PLN', date: '2026-11-02', category_id: null, description: null, merchant: 'Bistro',
  category_splits: [], is_debt: false, is_split_receivable: false, updated_at: '2026-11-02T10:00:00Z', encrypted_fields: [] };

let transport: FakeTransport;
let tokens: { getAccessToken: jest.Mock; forceRefresh: jest.Mock };
let api: AiBudgetApiClient;

beforeEach(() => {
  transport = new FakeTransport();
  tokens = { getAccessToken: jest.fn().mockResolvedValue('aba_at_1'), forceRefresh: jest.fn().mockResolvedValue('aba_at_2') };
  api = new AiBudgetApiClient(config, transport, tokens as unknown as AiBudgetTokenManager);
});

test('every account-scoped call sends X-Account-Id and the bearer token', async () => {
  transport.queue('GET /public/v1/expenses', 200, { data: [expense], next_cursor: null, has_more: false });
  const page = await api.listExpenses('u1', 'acc-1', { date_from: '2026-11-01' });
  expect(page.data).toHaveLength(1);
  expect(transport.requests[0].headers).toMatchObject({ 'X-Account-Id': 'acc-1', Authorization: 'Bearer aba_at_1' });
  expect(transport.requests[0].query).toMatchObject({ date_from: '2026-11-01' });
  expect(transport.requests[0].url).toBe('https://api.ai-budget.pl/public/v1/expenses');
});

test('changes, categories, update and delete are account-scoped too', async () => {
  transport.queue('GET /public/v1/expenses/changes', 200, { changes: [], next_cursor: 'cur2', has_more: false });
  transport.queue('GET /public/v1/categories', 200, { data: [{ id: 'cat1', name: 'Food', type: 'expense' }] });
  transport.queue('PATCH /public/v1/expenses/e1', 200, expense);
  transport.queue('DELETE /public/v1/expenses/e1', 204, '');
  expect((await api.getChanges('u1', 'acc-1', null)).next_cursor).toBe('cur2');
  expect(await api.listCategories('u1', 'acc-1')).toEqual([{ id: 'cat1', name: 'Food', type: 'expense' }]);
  await api.updateExpense('u1', 'acc-1', 'e1', { merchant: null });
  await expect(api.deleteExpense('u1', 'acc-1', 'e1')).resolves.toBeUndefined();
  expect(transport.requests[0].query).toEqual({ limit: 200 });
  expect(transport.requests[2].json).toEqual({ merchant: null });
  for (const r of transport.requests) expect(r.headers).toMatchObject({ 'X-Account-Id': 'acc-1' });
});

test('listAccounts unwraps data and sends no X-Account-Id', async () => {
  transport.queue('GET /public/v1/accounts', 200, { data: [{ id: 'acc-1', name: null, type: null, base_currency: null, access: 'read', active: false, reason: 'role' }] });
  expect(await api.listAccounts('u1')).toHaveLength(1);
  expect(transport.requests[0].headers).not.toHaveProperty('X-Account-Id');
});

test('a 401 invalid_token refreshes once and retries once', async () => {
  transport.queue('GET /public/v1/expenses', 401, { error: { code: 'invalid_token', message: 'x' } });
  transport.queue('GET /public/v1/expenses', 200, { data: [], next_cursor: null, has_more: false });
  await api.listExpenses('u1', 'acc-1', {});
  expect(tokens.forceRefresh).toHaveBeenCalledTimes(1);
  expect(tokens.forceRefresh).toHaveBeenCalledWith('u1', 'aba_at_1');
  expect(transport.requests[1].headers).toMatchObject({ Authorization: 'Bearer aba_at_2' });
});

test('a second 401 is not retried again', async () => {
  transport.queue('GET /public/v1/expenses', 401, { error: { code: 'invalid_token', message: 'x' } });
  transport.queue('GET /public/v1/expenses', 401, { error: { code: 'invalid_token', message: 'x' } });
  await expect(api.listExpenses('u1', 'acc-1', {})).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
  expect(tokens.forceRefresh).toHaveBeenCalledTimes(1);
  expect(transport.requests).toHaveLength(2);
});

test('createExpense sends Idempotency-Key and string amounts', async () => {
  transport.queue('POST /public/v1/expenses', 201, expense);
  await api.createExpense('u1', 'acc-1', { amount: '45.00', date: '2026-11-02', merchant: 'Bistro' }, 'b7e3c1a9-4f2d-4e8b-9a6c-0d5f7e1b3a24');
  expect(transport.requests[0].headers!['Idempotency-Key']).toBe('b7e3c1a9-4f2d-4e8b-9a6c-0d5f7e1b3a24');
  expect(transport.requests[0].headers!['X-Account-Id']).toBe('acc-1');
  expect(typeof (transport.requests[0].json as { amount: unknown }).amount).toBe('string');
});

test('an amount that is not a decimal string with at most 2 places is refused before any call', async () => {
  await expect(api.createExpense('u1', 'acc-1', { amount: '45.001', date: '2026-11-02' }, '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e')).rejects.toThrow();
  await expect(api.updateExpense('u1', 'acc-1', 'e1', { amount: 45 as unknown as string })).rejects.toThrow();
  expect(transport.requests).toHaveLength(0);
});

test('account_not_granted notifies the listener and throws AiBudgetApiError(403, code)', async () => {
  const listener = jest.fn().mockResolvedValue(undefined);
  api.setAccountAccessListener(listener);
  transport.queue('GET /public/v1/expenses', 403, { error: { code: 'account_not_granted', message: 'x' } });
  const err = await api.listExpenses('u1', 'acc-1', {}).catch((e) => e);
  expect(err).toBeInstanceOf(AiBudgetApiError);
  expect(err).toMatchObject({ status: 403, code: 'account_not_granted' });
  expect(listener).toHaveBeenCalledWith('u1', 'acc-1', 'account_not_granted');
});

test('other 403 codes do not notify the listener', async () => {
  const listener = jest.fn().mockResolvedValue(undefined);
  api.setAccountAccessListener(listener);
  transport.queue('POST /public/v1/expenses', 403, { error: { code: 'insufficient_scope', message: 'x' } });
  await expect(api.createExpense('u1', 'acc-1', { amount: '1.00', date: '2026-11-02' }, '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e')).rejects.toMatchObject({ code: 'insufficient_scope' });
  expect(listener).not.toHaveBeenCalled();
});

test('errors carry no token, header or body', async () => {
  transport.queue('GET /public/v1/accounts', 500, { error: { code: 'internal_error', message: 'x' } });
  const err = await api.listAccounts('u1').catch((e) => e);
  expect(err).toBeInstanceOf(AiBudgetApiError);
  expect(JSON.stringify(err)).not.toContain('aba_at_1');
  expect(String(err.message)).not.toContain('aba_at_1');
  expect(Object.keys(err)).toEqual(expect.not.arrayContaining(['config', 'request', 'response', 'headers', 'data']));
});

test('429 surfaces retryAfterSec from Retry-After', async () => {
  transport.queue('GET /public/v1/accounts', 429, { error: { code: 'rate_limited', message: 'x' } }, { 'retry-after': '12' });
  const err = await api.listAccounts('u1').catch((e) => e);
  expect(err).toMatchObject({ status: 429, code: 'rate_limited', retryAfterSec: 12 });
});

test('a non-JSON error body gets an http_<status> code', async () => {
  transport.queue('GET /public/v1/accounts', 502, '<html>bad gateway</html>');
  await expect(api.listAccounts('u1')).rejects.toMatchObject({ status: 502, code: 'http_502' });
});

test('a 401 with a code other than invalid_token is not refreshed', async () => {
  transport.queue('GET /public/v1/expenses', 401, { error: { code: 'unauthorized', message: 'x' } });
  await expect(api.listExpenses('u1', 'acc-1', {})).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  expect(tokens.forceRefresh).not.toHaveBeenCalled();
  expect(transport.requests).toHaveLength(1);
});

test('an Idempotency-Key that is not a UUID v4 is refused before any call', async () => {
  for (const key of ['k', 'b7e3c1a9-4f2d-1e8b-9a6c-0d5f7e1b3a24', 'b7e3c1a9-4f2d-4e8b-7a6c-0d5f7e1b3a24', '']) {
    await expect(api.createExpense('u1', 'acc-1', { amount: '1.00', date: '2026-11-02' }, key)).rejects.toThrow('UUID v4');
  }
  expect(transport.requests).toHaveLength(0);
});
