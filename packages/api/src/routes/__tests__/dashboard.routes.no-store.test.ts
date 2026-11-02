import express from 'express';
import request from 'supertest';

jest.mock('../../middleware/auth.middleware', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { userId: 'u1', email: 'x@y.z', role: 'user' };
    next();
  },
}));
jest.mock('../../services/dashboard/dashboard.instance', () => ({ dashboardService: { getSummary: jest.fn().mockResolvedValue({}) } }));
jest.mock('../../services/ai-budget', () => ({
  aiBudget: { dashboard: { getCompany: jest.fn().mockResolvedValue({ state: 'syncing' }), getPersonal: jest.fn().mockResolvedValue({ state: 'no_private_accounts' }) } },
}));

import dashboardRoutes from '../dashboard.routes';

const app = express();
app.use('/api/dashboard', dashboardRoutes);

test.each(['/api/dashboard/ai-budget', '/api/dashboard/personal'])('%s carries Cache-Control: no-store', async (path) => {
  const res = await request(app).get(path);
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
});
