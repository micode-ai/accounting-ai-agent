import { CryptoService } from '../../crypto.service';
import type { AiBudgetConfig } from '../ai-budget.config';
import { buildAiBudget } from '../ai-budget.instance';
import { FakeRedis, FakeTransport, InMemoryAiBudgetRepository } from './fakes';

process.env.CREDENTIALS_ENCRYPTION_KEY = 'a'.repeat(64);

const config: AiBudgetConfig = {
  clientId: 'cid', clientSecret: 'csecret', apiUrl: 'https://api.ai-budget.pl', authorizeUrl: 'https://app.ai-budget.pl/authorize',
  tokenUrl: 'https://api.ai-budget.pl/oauth/token', revokeUrl: 'https://api.ai-budget.pl/oauth/revoke',
  redirectUri: 'https://api.eksiegowyai.pl/api/integrations/ai-budget/callback', frontendUrl: 'https://eksiegowyai.pl',
};

let crypto: CryptoService;
let repo: InMemoryAiBudgetRepository;
let transport: FakeTransport;
let services: ReturnType<typeof buildAiBudget>;

beforeEach(() => {
  crypto = new CryptoService();
  repo = new InMemoryAiBudgetRepository();
  transport = new FakeTransport();
  services = buildAiBudget(config, { repo, redis: new FakeRedis(), crypto, transport, wfirma: {} as never });
});

const seedConnection = (expiresInMs: number): void => {
  repo.seedConnection('u1', {
    accessTokenEnc: crypto.encryptToString('aba_at_1'), refreshTokenEnc: crypto.encryptToString('aba_rt_1'),
    accessTokenExpiresAt: new Date(Date.now() + expiresInMs),
  });
};

test('a refresh hands account_ids to accounts.handleAccountIds', async () => {
  seedConnection(10_000);
  const handle = jest.spyOn(services.accounts, 'handleAccountIds').mockResolvedValue();
  transport.queue('POST /oauth/token', 200, { access_token: 'aba_at_2', refresh_token: 'aba_rt_2', expires_in: 3600, scope: 's', account_ids: ['x', 'y'] });
  expect(await services.tokens.getAccessToken('u1')).toBe('aba_at_2');
  expect(handle).toHaveBeenCalledWith('u1', ['x', 'y']);
});

test('a 403 account error on an account-scoped call reaches accounts.handleAccessError', async () => {
  seedConnection(3600_000);
  const handle = jest.spyOn(services.accounts, 'handleAccessError').mockResolvedValue();
  transport.queue('GET /public/v1/categories', 403, { error: { code: 'grant_inactive' } });
  await expect(services.api.listCategories('u1', 'b1')).rejects.toMatchObject({ status: 403, code: 'grant_inactive' });
  expect(handle).toHaveBeenCalledWith('u1', 'b1', 'grant_inactive');
});

test('a company change starts a full resync', async () => {
  seedConnection(3600_000);
  const syncCompany = jest.spyOn(services.sync, 'syncCompany').mockResolvedValue('synced');
  transport.queue('GET /public/v1/accounts', 200, {
    data: [{ id: 'b1', name: 'B1', type: 'business', base_currency: 'PLN', access: 'read', active: true, reason: null }],
  });
  await services.accounts.syncAccountList('u1');
  expect(syncCompany).toHaveBeenCalledWith('u1', { fullResync: true });
});
