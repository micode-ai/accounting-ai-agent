import { getAiBudgetConfig, AI_BUDGET_SCOPES } from '../ai-budget.config';

const fullEnv = { AI_BUDGET_CLIENT_ID: 'id', AI_BUDGET_CLIENT_SECRET: 'secret', BACKEND_URL: 'https://api.eksiegowyai.pl/', FRONTEND_URL: 'https://eksiegowyai.pl' } as Record<string, string | undefined>;

test('missing secret hides the feature', () => { expect(getAiBudgetConfig({ AI_BUDGET_CLIENT_ID: 'x', BACKEND_URL: 'https://api.eksiegowyai.pl', FRONTEND_URL: 'https://eksiegowyai.pl' } as Record<string, string | undefined>, true)).toBeNull(); });
test('missing encryption key hides the feature', () => { expect(getAiBudgetConfig(fullEnv, false)).toBeNull(); });
test('missing frontend or backend url hides the feature', () => {
  expect(getAiBudgetConfig({ ...fullEnv, FRONTEND_URL: '' }, true)).toBeNull();
  expect(getAiBudgetConfig({ ...fullEnv, BACKEND_URL: '' }, true)).toBeNull();
});
test('derives URLs', () => {
  expect(getAiBudgetConfig(fullEnv, true)).toMatchObject({ apiUrl: 'https://api.ai-budget.pl', authorizeUrl: 'https://app.ai-budget.pl/authorize',
    tokenUrl: 'https://api.ai-budget.pl/oauth/token', revokeUrl: 'https://api.ai-budget.pl/oauth/revoke',
    redirectUri: 'https://api.eksiegowyai.pl/api/integrations/ai-budget/callback', frontendUrl: 'https://eksiegowyai.pl' });
});
test('overrides and trailing slashes', () => {
  expect(getAiBudgetConfig({ ...fullEnv, AI_BUDGET_API_URL: 'http://x/', AI_BUDGET_AUTHORIZE_URL: 'http://y/authorize/' }, true))
    .toMatchObject({ apiUrl: 'http://x', tokenUrl: 'http://x/oauth/token', authorizeUrl: 'http://y/authorize' });
});
test('scopes are exact', () => { expect(AI_BUDGET_SCOPES).toBe('expenses:read expenses:write categories:read receipts:read'); });
test('in production a non-https AI Budget URL hides the feature', () => {
  const prod = { ...fullEnv, NODE_ENV: 'production' };
  expect(getAiBudgetConfig(prod, true)).not.toBeNull();
  expect(getAiBudgetConfig({ ...prod, AI_BUDGET_API_URL: 'http://api.ai-budget.pl' }, true)).toBeNull();
  expect(getAiBudgetConfig({ ...prod, AI_BUDGET_AUTHORIZE_URL: 'http://app.ai-budget.pl/authorize' }, true)).toBeNull();
  expect(getAiBudgetConfig({ ...prod, AI_BUDGET_API_URL: 'ftp://x' }, true)).toBeNull();
});
test('outside production http is allowed but other schemes are not', () => {
  expect(getAiBudgetConfig({ ...fullEnv, NODE_ENV: 'development', AI_BUDGET_API_URL: 'http://localhost:3000' }, true)).not.toBeNull();
  expect(getAiBudgetConfig({ ...fullEnv, AI_BUDGET_API_URL: 'not a url' }, true)).toBeNull();
});
