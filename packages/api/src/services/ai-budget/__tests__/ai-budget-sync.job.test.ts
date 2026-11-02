import { AiBudgetSyncJob, RECONNECT_RETENTION_MS, SYNC_INTERVAL_MS } from '../ai-budget-sync.job';
import { FakeRedis, InMemoryAiBudgetRepository } from './fakes';

const NOW = new Date('2026-11-02T12:00:00Z');
let repo: InMemoryAiBudgetRepository;
let redis: FakeRedis;
let calls: string[];
let accounts: { syncAccountList: jest.Mock };
let sync: { syncCompany: jest.Mock };
const job = () => new AiBudgetSyncJob({ repo, accounts, sync, redis }, () => NOW);

beforeEach(() => {
  repo = new InMemoryAiBudgetRepository();
  redis = new FakeRedis();
  calls = [];
  accounts = { syncAccountList: jest.fn(async (u: string) => { calls.push(`list:${u}`); }) };
  sync = { syncCompany: jest.fn(async (u: string) => { calls.push(`sync:${u}`); return 'synced'; }) };
});

test('tick refreshes the account list then syncs the company account of each active connection, sequentially', async () => {
  repo.seedConnection('u1');
  repo.seedConnection('u2');
  repo.seedConnection('u3', { status: 'needs_reconnect' });
  await job().tick();
  expect(calls).toEqual(['list:u1', 'sync:u1', 'list:u2', 'sync:u2']);
});

test('one user failing does not stop the others', async () => {
  repo.seedConnection('u1');
  repo.seedConnection('u2');
  accounts.syncAccountList.mockRejectedValueOnce(new Error('boom'));
  sync.syncCompany.mockRejectedValueOnce(new Error('boom'));
  await job().tick();
  expect(sync.syncCompany).toHaveBeenCalledWith('u2');
  expect(accounts.syncAccountList).toHaveBeenCalledWith('u2');
});

test('mirrors of connections in needs_reconnect for more than 30 days are cleared; younger ones kept', async () => {
  repo.seedConnection('old', { status: 'needs_reconnect', statusChangedAt: new Date(NOW.getTime() - RECONNECT_RETENTION_MS - 86400_000) });
  repo.seedConnection('young', { status: 'needs_reconnect', statusChangedAt: new Date(NOW.getTime() - RECONNECT_RETENTION_MS + 86400_000) });
  repo.seedAccount('old', { externalId: 'o1', label: 'company', lastSyncedAt: NOW, syncCursor: 'c' });
  repo.seedAccount('young', { externalId: 'y1', label: 'company', lastSyncedAt: NOW, syncCursor: 'c' });
  await job().tick();
  expect(repo.accountRows.get('o1-row')).toMatchObject({ syncCursor: null, lastSyncedAt: null });
  expect(repo.accountRows.get('y1-row')).toMatchObject({ syncCursor: 'c' });
});

test('a second tick is skipped while another process holds the lock', async () => {
  repo.seedConnection('u1');
  await job().tick();
  await job().tick();
  expect(sync.syncCompany).toHaveBeenCalledTimes(1);
});

test('start runs a tick and schedules 15-minute ticks; stop clears the timer', async () => {
  jest.useFakeTimers();
  try {
    const j = job();
    const spy = jest.spyOn(j, 'tick').mockResolvedValue();
    j.start();
    expect(spy).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(SYNC_INTERVAL_MS);
    expect(spy).toHaveBeenCalledTimes(2);
    j.stop();
    jest.advanceTimersByTime(SYNC_INTERVAL_MS * 2);
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});
