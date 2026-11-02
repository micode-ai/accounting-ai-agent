import { test, expect, Page, Route } from '@playwright/test';
import { dismissCookieBanner } from '../helpers/test-utils';
import en from '../../../src/i18n/locales/en.json';

/**
 * E2E coverage for /settings/integrations (AI Budget) and the OAuth completion page.
 * Every /api/integrations/ai-budget/** call is mocked with page.route and the AI Budget authorize
 * host is stubbed, so no live AI Budget call is ever made. Auth is mocked too, so no backend is needed.
 */

const t = en.aiBudget;
const BASE = '**/api/integrations/ai-budget/**';

type Account = {
  id: string;
  externalId: string;
  name: string;
  type: string;
  currency: string;
  access: 'read' | 'read_write';
  active: boolean;
  inactiveReason: string | null;
  label: 'company' | 'other_business' | 'private';
  labelSource: 'auto' | 'manual';
};

const account = (over: Partial<Account> & { id: string }): Account => ({
  externalId: `ext-${over.id}`,
  name: 'Firma',
  type: 'business',
  currency: 'PLN',
  access: 'read_write',
  active: true,
  inactiveReason: null,
  label: 'company',
  labelSource: 'auto',
  ...over,
});

type Connection = {
  status: 'active' | 'needs_reconnect';
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  needsCompanyChoice: boolean;
  accounts: Account[];
};

const connection = (over: Partial<Connection> = {}): Connection => ({
  status: 'active',
  lastSyncedAt: '2026-11-01T10:00:00.000Z',
  lastSyncError: null,
  needsCompanyChoice: false,
  accounts: [account({ id: 'acc-b1' })],
  ...over,
});

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Serves GET /status from `state` and lets each test add handlers for the other routes. */
async function mockApi(
  page: Page,
  state: { status: unknown },
  handlers: Record<string, (route: Route) => Promise<void>> = {},
) {
  await page.route(BASE, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/integrations/ai-budget', '');
    const key = `${req.method()} ${path}`;
    if (key === 'GET /status') return json(route, 200, { success: true, data: state.status });
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (new RegExp(`^${pattern}$`).test(key)) return handler(route);
    }
    return json(route, 404, { success: false, error: 'not_mocked', message: key });
  });
}

/**
 * Authenticates without a backend: seeds the tokens the AuthContext reads and mocks GET /api/auth/me.
 * Any other API call the shell makes is answered with an empty success so nothing reaches a server.
 */
async function mockAuth(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'e2e-token');
    localStorage.setItem('refreshToken', 'e2e-refresh');
    localStorage.setItem('locale', 'en');
  });
  await page.route('**/api/**', (route) => json(route, 200, { success: true, data: [] }));
  await page.route('**/api/auth/me', (route) =>
    json(route, 200, {
      success: true,
      data: {
        id: 'u1',
        email: 'e2e@example.com',
        firstName: 'E2E',
        lastName: 'User',
        locale: 'en',
        role: 'USER',
        hasGoogleAuth: false,
        company: null,
        organizationId: null,
        orgRole: 'member',
        orgMembershipStatus: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
  );
  await page.route('**/health', (route) =>
    json(route, 200, { status: 'ok', timestamp: new Date().toISOString(), uptimeSeconds: 1, checks: {}, integrations: {} }),
  );
}

async function openSettings(page: Page, url = '/settings/integrations') {
  await page.goto(url);
  await dismissCookieBanner(page);
}

test.describe('AI Budget integration settings', () => {
  test.beforeEach(async ({ page }) => {
    // Never reach the real AI Budget: any navigation there gets a stub page.
    await page.route('https://app.ai-budget.pl/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>authorize stub</body></html>' }),
    );
    await mockAuth(page);
  });

  test('not connected: Connect posts /connect and navigates to the authorize URL', async ({ page }) => {
    const state = { status: { available: true, connection: null } };
    let connectPosted = false;
    await mockApi(page, state, {
      'POST /connect': async (route) => {
        connectPosted = true;
        await json(route, 200, {
          success: true,
          data: { authorizeUrl: 'https://app.ai-budget.pl/authorize?client_id=x&state=s' },
        });
      },
    });
    await openSettings(page);
    const connect = page.getByRole('button', { name: t.settings.connect });
    await expect(connect).toBeVisible();
    await Promise.all([page.waitForURL(/app\.ai-budget\.pl\/authorize/), connect.click()]);
    expect(connectPosted).toBe(true);
  });

  test('connected: lists accounts with label, automatic/manual hint and read-only badge', async ({ page }) => {
    const state = {
      status: {
        available: true,
        connection: connection({
          accounts: [
            account({ id: 'acc-b1', name: 'Firma', label: 'company', labelSource: 'auto' }),
            account({ id: 'acc-p1', name: 'Dom', type: 'personal', label: 'private', labelSource: 'manual', access: 'read' }),
          ],
        }),
      },
    };
    await mockApi(page, state);
    await openSettings(page);
    await expect(page.getByText(t.settings.status.active)).toBeVisible();
    await expect(page.getByText('Firma', { exact: true })).toBeVisible();
    await expect(page.getByText('Dom', { exact: true })).toBeVisible();
    await expect(page.getByLabel(t.settings.labelFor.replace('{name}', 'Firma'))).toHaveValue('company');
    await expect(page.getByLabel(t.settings.labelFor.replace('{name}', 'Dom'))).toHaveValue('private');
    await expect(page.getByText(t.settings.labelAuto)).toBeVisible();
    await expect(page.getByText(t.settings.labelManual)).toBeVisible();
    await expect(page.getByText(t.settings.readOnly)).toBeVisible();
  });

  test('choosing a different company account sends PATCH {label:"company"}', async ({ page }) => {
    const state = {
      status: {
        available: true,
        connection: connection({
          accounts: [
            account({ id: 'acc-b1', name: 'Firma A', label: 'company' }),
            account({ id: 'acc-b2', name: 'Firma B', label: 'other_business' }),
          ],
        }),
      },
    };
    await mockApi(page, state, {
      'PATCH /accounts/acc-b2/label': (route) => json(route, 200, { success: true, data: [] }),
    });
    await openSettings(page);
    const req = page.waitForRequest((r) => r.method() === 'PATCH' && /\/accounts\/acc-b2\/label$/.test(r.url()));
    await page.getByLabel(t.settings.labelFor.replace('{name}', 'Firma B')).selectOption('company');
    expect((await req).postDataJSON()).toEqual({ label: 'company' });
  });

  test('label change rejected with 409 shows the account-unavailable message', async ({ page }) => {
    const state = {
      status: {
        available: true,
        connection: connection({
          accounts: [
            account({ id: 'acc-b1', name: 'Firma A', label: 'company' }),
            account({ id: 'acc-b2', name: 'Firma B', label: 'other_business' }),
          ],
        }),
      },
    };
    await mockApi(page, state, {
      'PATCH /accounts/acc-b2/label': (route) =>
        json(route, 409, { success: false, error: 'account_unavailable', message: 'unavailable' }),
    });
    await openSettings(page);
    await page.getByLabel(t.settings.labelFor.replace('{name}', 'Firma B')).selectOption('company');
    // The API client retries a 409 with backoff before surfacing it.
    await expect(page.getByText(t.settings.accountUnavailableConflict)).toBeVisible({ timeout: 30000 });
  });

  test('several business accounts: the company choice prompt is shown', async ({ page }) => {
    const state = {
      status: {
        available: true,
        connection: connection({
          needsCompanyChoice: true,
          accounts: [
            account({ id: 'acc-b1', name: 'Firma A', label: 'other_business' }),
            account({ id: 'acc-b2', name: 'Firma B', label: 'other_business' }),
          ],
        }),
      },
    };
    await mockApi(page, state, {
      'PATCH /accounts/acc-b1/label': (route) => json(route, 200, { success: true, data: [] }),
    });
    await openSettings(page);
    const prompt = page.getByTestId('company-choice-prompt');
    await expect(prompt).toBeVisible();
    await expect(prompt.getByText(t.settings.chooseCompany)).toBeVisible();
    const req = page.waitForRequest((r) => r.method() === 'PATCH' && /\/accounts\/acc-b1\/label$/.test(r.url()));
    await prompt.getByRole('button', { name: /Firma A/ }).click();
    expect((await req).postDataJSON()).toEqual({ label: 'company' });
  });

  test('needs_reconnect: reconnect banner and button', async ({ page }) => {
    const state = { status: { available: true, connection: connection({ status: 'needs_reconnect' }) } };
    await mockApi(page, state);
    await openSettings(page);
    await expect(page.getByText(t.settings.reconnectBanner)).toBeVisible();
    await expect(page.getByRole('button', { name: t.settings.reconnect })).toBeVisible();
    await expect(page.getByRole('button', { name: t.settings.syncNow })).toHaveCount(0);
  });

  test('disconnect requires confirmation and posts /disconnect', async ({ page }) => {
    const state: { status: unknown } = { status: { available: true, connection: connection() } };
    let disconnects = 0;
    await mockApi(page, state, {
      'POST /disconnect': async (route) => {
        disconnects += 1;
        state.status = { available: true, connection: null };
        await json(route, 200, { success: true, data: { revokedRemotely: true } });
      },
    });
    await openSettings(page);
    await page.getByRole('button', { name: t.settings.disconnect }).click();
    await expect(page.getByText(t.settings.disconnectConfirm)).toBeVisible();
    expect(disconnects).toBe(0);
    // Cancel leaves the connection alone.
    await page.getByRole('button', { name: t.settings.cancel }).click();
    expect(disconnects).toBe(0);
    await page.getByRole('button', { name: t.settings.disconnect }).click();
    const req = page.waitForRequest((r) => r.method() === 'POST' && /\/disconnect$/.test(r.url()));
    await page.getByRole('button', { name: t.settings.disconnect }).last().click();
    await req;
    await expect(page.getByRole('button', { name: t.settings.connect })).toBeVisible();
    expect(disconnects).toBe(1);
  });

  test('?ai_budget=error&reason=access_denied shows the error message', async ({ page }) => {
    await mockApi(page, { status: { available: true, connection: null } });
    await openSettings(page, '/settings/integrations?ai_budget=error&reason=access_denied');
    await expect(page.getByText(t.settings.error.access_denied)).toBeVisible();
    await expect(page).toHaveURL(/\/settings\/integrations$/);
  });

  test('available:false shows the unavailable note and no Connect button', async ({ page }) => {
    await mockApi(page, { status: { available: false, connection: null } });
    await openSettings(page);
    await expect(page.getByText(t.settings.error.unavailable)).toBeVisible();
    await expect(page.getByRole('button', { name: t.settings.connect })).toHaveCount(0);
  });

  test('an account AI Budget no longer exposes is shown as "no longer available"', async ({ page }) => {
    const state = {
      status: {
        available: true,
        connection: connection({
          accounts: [
            account({ id: 'acc-b1', name: 'Firma', label: 'company' }),
            account({ id: 'acc-gone', name: '', type: '', currency: '', active: false, label: 'private' }),
          ],
        }),
      },
    };
    await mockApi(page, state);
    await openSettings(page);
    await expect(page.getByText(t.settings.unavailable)).toBeVisible();
    await expect(page.getByText('Firma', { exact: true })).toBeVisible();
  });

  test('complete page: success posts {code,state}, drops them from the URL and lands connected', async ({ page }) => {
    const state: { status: unknown } = { status: { available: true, connection: null } };
    await mockApi(page, state, {
      'POST /complete': async (route) => {
        state.status = { available: true, connection: connection() };
        await json(route, 200, { success: true, data: { connected: true } });
      },
    });
    const req = page.waitForRequest((r) => r.method() === 'POST' && /\/complete$/.test(r.url()));
    await page.goto('/settings/integrations/ai-budget/complete?code=the-code&state=the-state');
    expect((await req).postDataJSON()).toEqual({ code: 'the-code', state: 'the-state' });
    await expect(page.getByText(t.settings.connectedToast)).toBeVisible();
    await expect(page).toHaveURL(/\/settings\/integrations$/);
  });

  test('complete page: state_mismatch routes to the error notice', async ({ page }) => {
    await mockApi(page, { status: { available: true, connection: null } }, {
      'POST /complete': (route) =>
        json(route, 403, { success: false, error: 'state_mismatch', message: 'state mismatch' }),
    });
    await page.goto('/settings/integrations/ai-budget/complete?code=c&state=s');
    await expect(page.getByText(t.settings.error.state_mismatch)).toBeVisible();
    await expect(page).toHaveURL(/\/settings\/integrations$/);
  });
});
