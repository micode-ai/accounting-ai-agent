import express from 'express';
import request from 'supertest';

const mockServices = {
  config: { frontendUrl: 'https://eksiegowyai.pl' },
  oauth: { getStatus: jest.fn(), startConnect: jest.fn(), handleCallback: jest.fn(), completeConnect: jest.fn(), disconnect: jest.fn() },
  accounts: { setLabel: jest.fn() },
  sync: { syncCompany: jest.fn() },
};
let mockCurrent: typeof mockServices | null = mockServices;

jest.mock('../../services/ai-budget/ai-budget.instance', () => ({
  get aiBudget() { return mockCurrent; },
}));

// A request is authenticated when it carries `Authorization: Bearer <userId>`.
jest.mock('../../middleware/auth.middleware', () => ({
  authenticate: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    req.user = { userId: m[1], email: 'x@y.z', role: 'user' };
    next();
  },
}));

import aiBudgetRoutes from '../../routes/ai-budget.routes';
import { AiBudgetAccountNotFoundError, AiBudgetAccountUnavailableError } from '../../services/ai-budget/ai-budget-errors';

const app = express();
app.use(express.json());
app.use('/api/integrations/ai-budget', aiBudgetRoutes);

const BASE = '/api/integrations/ai-budget';
const AUTH = { Authorization: 'Bearer u1' };
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, connectionId: 'c', userId: 'u1', externalId: id.replace('-row', ''), name: 'N', type: 'business', currency: 'PLN', access: 'read',
  active: true, inactiveReason: null, label: 'company', labelSource: 'manual', syncCursor: 'secret-cursor', syncGeneration: 1,
  lastSyncedAt: null, lastSyncError: null, fullResyncAt: null, ...over,
});

beforeEach(() => {
  mockCurrent = mockServices;
  process.env.FRONTEND_URL = 'https://eksiegowyai.pl';
});

describe('GET /callback', () => {
  test('needs no JWT and answers 302 to the completion URL the service returns', async () => {
    mockServices.oauth.handleCallback.mockResolvedValue('https://eksiegowyai.pl/settings/integrations/ai-budget/complete?code=c&state=s');
    const res = await request(app).get(`${BASE}/callback`).query({ code: 'c', state: 's' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://eksiegowyai.pl/settings/integrations/ai-budget/complete?code=c&state=s');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(mockServices.oauth.handleCallback).toHaveBeenCalledWith({ code: 'c', state: 's', error: undefined });
  });

  test('passes only string query values', async () => {
    mockServices.oauth.handleCallback.mockResolvedValue('https://eksiegowyai.pl/x');
    await request(app).get(`${BASE}/callback?state=a&state=b&error=access_denied`);
    expect(mockServices.oauth.handleCallback).toHaveBeenCalledWith({ code: undefined, state: undefined, error: 'access_denied' });
  });

  test('redirects with reason=unavailable when the feature is off', async () => {
    mockCurrent = null;
    const res = await request(app).get(`${BASE}/callback`).query({ code: 'c', state: 's' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://eksiegowyai.pl/settings/integrations?ai_budget=error&reason=unavailable');
  });

  test('an unexpected failure still redirects, never a 500 page', async () => {
    mockServices.oauth.handleCallback.mockRejectedValue(new Error('boom'));
    const res = await request(app).get(`${BASE}/callback`).query({ code: 'c', state: 's' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://eksiegowyai.pl/settings/integrations?ai_budget=error&reason=exchange_failed');
  });
});

describe('POST /complete', () => {
  test('completes the connection for the signed-in user', async () => {
    mockServices.oauth.completeConnect.mockResolvedValue({ ok: true });
    const res = await request(app).post(`${BASE}/complete`).set(AUTH).send({ code: 'c', state: 's' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ success: true, data: { connected: true } });
    expect(mockServices.oauth.completeConnect).toHaveBeenCalledWith('u1', { code: 'c', state: 's' });
  });

  test.each(['invalid_state', 'state_mismatch', 'exchange_failed'])('answers 400 with reason %s', async (reason) => {
    mockServices.oauth.completeConnect.mockResolvedValue({ ok: false, reason });
    const res = await request(app).post(`${BASE}/complete`).set(AUTH).send({ code: 'c', state: 's' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: reason });
  });

  test('validates the body', async () => {
    expect((await request(app).post(`${BASE}/complete`).set(AUTH).send({ code: 'c' })).status).toBe(400);
    expect((await request(app).post(`${BASE}/complete`).set(AUTH).send({ code: '', state: 's' })).status).toBe(400);
    expect((await request(app).post(`${BASE}/complete`).set(AUTH).send({ code: 'x'.repeat(513), state: 's' })).status).toBe(400);
    expect(mockServices.oauth.completeConnect).not.toHaveBeenCalled();
  });

  test('answers 503 when the feature is unavailable', async () => {
    mockCurrent = null;
    expect((await request(app).post(`${BASE}/complete`).set(AUTH).send({ code: 'c', state: 's' })).status).toBe(503);
  });

  test('an unexpected failure answers 500 with exchange_failed', async () => {
    mockServices.oauth.completeConnect.mockRejectedValue(new Error('boom'));
    const res = await request(app).post(`${BASE}/complete`).set(AUTH).send({ code: 'c', state: 's' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'exchange_failed' });
  });
});

describe('authenticated routes', () => {
  test('every route but the callback needs a JWT', async () => {
    expect((await request(app).get(`${BASE}/status`)).status).toBe(401);
    expect((await request(app).post(`${BASE}/connect`)).status).toBe(401);
    expect((await request(app).post(`${BASE}/complete`).send({ code: 'c', state: 's' })).status).toBe(401);
    expect((await request(app).post(`${BASE}/disconnect`)).status).toBe(401);
    expect((await request(app).post(`${BASE}/sync`)).status).toBe(401);
    expect((await request(app).patch(`${BASE}/accounts/b1-row/label`).send({ label: 'private' })).status).toBe(401);
  });

  test('GET /status returns the envelope', async () => {
    const data = { available: true, connection: null };
    mockServices.oauth.getStatus.mockResolvedValue(data);
    const res = await request(app).get(`${BASE}/status`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data });
    expect(mockServices.oauth.getStatus).toHaveBeenCalledWith('u1');
  });

  test('GET /status reports available:false when the feature is off', async () => {
    mockCurrent = null;
    const res = await request(app).get(`${BASE}/status`).set(AUTH);
    expect(res.body).toEqual({ success: true, data: { available: false, connection: null } });
  });

  test('POST /connect returns the authorize URL', async () => {
    mockServices.oauth.startConnect.mockResolvedValue({ authorizeUrl: 'https://app.ai-budget.pl/authorize?x=1' });
    const res = await request(app).post(`${BASE}/connect`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { authorizeUrl: 'https://app.ai-budget.pl/authorize?x=1' } });
    expect(mockServices.oauth.startConnect).toHaveBeenCalledWith('u1');
  });

  test('POST /connect answers 503 when the feature is unavailable', async () => {
    mockCurrent = null;
    const res = await request(app).post(`${BASE}/connect`).set(AUTH);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, error: 'ai_budget_unavailable' });
  });

  test('POST /disconnect reports whether the remote revoke worked', async () => {
    mockServices.oauth.disconnect.mockResolvedValue({ revokedRemotely: false });
    const res = await request(app).post(`${BASE}/disconnect`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { revokedRemotely: false } });
    expect(mockServices.oauth.disconnect).toHaveBeenCalledWith('u1');
  });

  test('POST /disconnect answers 503 when the feature is unavailable', async () => {
    mockCurrent = null;
    expect((await request(app).post(`${BASE}/disconnect`).set(AUTH)).status).toBe(503);
  });

  test('POST /sync starts a sync without waiting for it', async () => {
    mockServices.sync.syncCompany.mockReturnValue(new Promise(() => undefined));
    const res = await request(app).post(`${BASE}/sync`).set(AUTH);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ success: true, data: { started: true } });
    expect(mockServices.sync.syncCompany).toHaveBeenCalledWith('u1');
  });

  test('POST /sync swallows a rejected sync', async () => {
    mockServices.sync.syncCompany.mockRejectedValue(new Error('boom'));
    expect((await request(app).post(`${BASE}/sync`).set(AUTH)).status).toBe(202);
  });
});

describe('PATCH /accounts/:accountId/label', () => {
  test('validates the enum', async () => {
    const res = await request(app).patch(`${BASE}/accounts/b1-row/label`).set(AUTH).send({ label: 'firma' });
    expect(res.status).toBe(400);
    expect(mockServices.accounts.setLabel).not.toHaveBeenCalled();
  });

  test('sets the label and returns the accounts without sync internals', async () => {
    mockServices.accounts.setLabel.mockResolvedValue([row('b1-row')]);
    const res = await request(app).patch(`${BASE}/accounts/b1-row/label`).set(AUTH).send({ label: 'company' });
    expect(res.status).toBe(200);
    expect(mockServices.accounts.setLabel).toHaveBeenCalledWith('u1', 'b1-row', 'company');
    expect(res.body.success).toBe(true);
    expect(res.body.data.accounts[0]).toEqual({
      id: 'b1-row', externalId: 'b1', name: 'N', type: 'business', currency: 'PLN', access: 'read', active: true, inactiveReason: null,
      label: 'company', labelSource: 'manual',
    });
    expect(JSON.stringify(res.body)).not.toContain('secret-cursor');
  });

  test('404 for a row of another user', async () => {
    mockServices.accounts.setLabel.mockRejectedValue(new AiBudgetAccountNotFoundError());
    const res = await request(app).patch(`${BASE}/accounts/other-row/label`).set(AUTH).send({ label: 'private' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: 'account_not_found' });
    expect(mockServices.accounts.setLabel).toHaveBeenCalledWith('u1', 'other-row', 'private');
  });

  test('409 when an unavailable account is made the company', async () => {
    mockServices.accounts.setLabel.mockRejectedValue(new AiBudgetAccountUnavailableError());
    const res = await request(app).patch(`${BASE}/accounts/b1-row/label`).set(AUTH).send({ label: 'company' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, error: 'account_unavailable' });
  });

  test('500 for any other failure', async () => {
    mockServices.accounts.setLabel.mockRejectedValue(new Error('db down'));
    expect((await request(app).patch(`${BASE}/accounts/b1-row/label`).set(AUTH).send({ label: 'private' })).status).toBe(500);
  });

  test('503 when the feature is unavailable', async () => {
    mockCurrent = null;
    expect((await request(app).patch(`${BASE}/accounts/b1-row/label`).set(AUTH).send({ label: 'private' })).status).toBe(503);
  });
});

describe('Cache-Control', () => {
  test('the status (account names, labels) is never cached by the browser', async () => {
    mockServices.oauth.getStatus.mockResolvedValue({ available: true, connection: null });
    const res = await request(app).get(`${BASE}/status`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
