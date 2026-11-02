import express from 'express';
import request from 'supertest';

const mockPrivateClient = { kind: 'private' };
const mockRedactingClient = { kind: 'redacting' };
const mockTraceOptions: Array<Record<string, unknown>> = [];
const mockFindConnection = jest.fn();

jest.mock('langsmith/traceable', () => ({
  traceable: (fn: (...a: unknown[]) => unknown, opts: Record<string, unknown>) => {
    mockTraceOptions.push(opts);
    return fn;
  },
}));
jest.mock('../../services/ai-chat/trace-redaction', () => ({
  getTraceClient: (o: { private?: boolean } = {}) => (o.private ? mockPrivateClient : mockRedactingClient),
}));
jest.mock('../../services/tts.instance', () => ({ ttsService: { synthesize: jest.fn().mockResolvedValue(Buffer.from('audio')) } }));
jest.mock('../../lib/prisma', () => ({
  prisma: { user: { update: jest.fn().mockResolvedValue({}) }, aiBudgetConnection: { findUnique: (...a: unknown[]) => mockFindConnection(...a) } },
}));
jest.mock('../../middleware/rate-limiter.middleware', () => ({ rateLimiter: () => (_q: unknown, _s: unknown, n: () => void) => n() }));
jest.mock('../../middleware/auth.middleware', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { userId: 'u1', email: 'x@y.z', role: 'user' };
    next();
  },
}));

import ttsRoutes from '../tts.routes';

const app = express();
app.use(express.json());
app.use('/api/tts', ttsRoutes);

beforeEach(() => { mockTraceOptions.length = 0; mockFindConnection.mockReset(); });

const speak = () => request(app).post('/api/tts/speak').send({ text: 'Hello' });

test('without an AI Budget connection the trace uses the redacting client, never the default one', async () => {
  mockFindConnection.mockResolvedValue(null);
  expect((await speak()).status).toBe(200);
  expect(mockTraceOptions[0].client).toBe(mockRedactingClient);
});

test('a revoked connection is not connected: redacting client', async () => {
  mockFindConnection.mockResolvedValue({ status: 'revoked' });
  await speak();
  expect(mockTraceOptions[0].client).toBe(mockRedactingClient);
});

test.each(['active', 'needs_reconnect'])('with a %s AI Budget connection the request cannot be tied to a conversation: private trace', async (status) => {
  mockFindConnection.mockResolvedValue({ status });
  await speak();
  expect(mockTraceOptions[0].client).toBe(mockPrivateClient);
});

test('when the connection cannot be looked up the trace is private (fail closed)', async () => {
  mockFindConnection.mockRejectedValue(new Error('db down'));
  expect((await speak()).status).toBe(200);
  expect(mockTraceOptions[0].client).toBe(mockPrivateClient);
});
