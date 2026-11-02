// Runs only with AI_BUDGET_DB_TEST=1 against a disposable DB (DATABASE_URL, see the SDD context).
import { PrismaClient } from '@prisma/client';
import { PrismaAiBudgetRepository, type MirrorExpenseInput } from '../ai-budget.repository';

const enabled = process.env.AI_BUDGET_DB_TEST === '1';
const d = enabled ? describe : describe.skip;

const exp = (externalId: string, date = '2026-11-01'): MirrorExpenseInput => ({
  externalId, amount: '12.30', currency: 'PLN', date, categoryId: null, categorySplits: [{ categoryId: 'c', amount: '12.30' }],
  merchant: 'Bistro', description: null, isDebt: false, isSplitReceivable: false, remoteUpdatedAt: new Date('2026-11-01T10:00:00Z'),
});

d('PrismaAiBudgetRepository (real DB)', () => {
  let prisma: PrismaClient;
  let repo: PrismaAiBudgetRepository;
  let userId: string;
  let connectionId: string;

  const account = (externalId: string, label: 'company' | 'other_business' | 'private' = 'private') =>
    repo.upsertAccount(connectionId, userId, {
      externalId, name: externalId, type: 'business', currency: 'PLN', access: 'read', active: true, inactiveReason: null, label, labelSource: 'auto',
    });

  beforeAll(async () => {
    prisma = new PrismaClient();
    repo = new PrismaAiBudgetRepository(prisma);
  });

  beforeEach(async () => {
    const user = await prisma.user.create({ data: { email: `aib-int-${Date.now()}-${Math.random()}@example.com`, referralCode: `R${Date.now()}${Math.floor(Math.random() * 1e6)}` } });
    userId = user.id;
    connectionId = (await repo.upsertConnectionTokens(userId, {
      accessTokenEnc: 'a', refreshTokenEnc: 'r', accessTokenExpiresAt: new Date(Date.now() + 3600_000), scope: 's',
    })).id;
  });

  afterEach(async () => {
    await prisma.user.delete({ where: { id: userId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('the partial unique index refuses two companies; replaceLabels demotes before promoting', async () => {
    await account('b1', 'company');
    await account('b2');
    await expect(account('b2', 'company')).rejects.toThrow();
    await repo.replaceLabels(userId, [
      { externalId: 'b2', label: 'company', labelSource: 'manual' },
      { externalId: 'b1', label: 'other_business', labelSource: 'manual' },
    ]);
    const labels = Object.fromEntries((await repo.listAccounts(userId)).map((a) => [a.externalId, a.label]));
    expect(labels).toEqual({ b1: 'other_business', b2: 'company' });
  });

  test('findMirrorExpense finds a row by remote id and returns null otherwise, per account', async () => {
    const co = await account('b1', 'company');
    const other = await account('b2', 'other_business');
    await repo.applyChangesPage(co.id, { upserts: [exp('e1')], deletes: [], nextCursor: 'c1', generation: 1 });
    expect(await repo.findMirrorExpense(co.id, 'e1')).toMatchObject({ externalId: 'e1', amount: '12.30', date: '2026-11-01' });
    expect(await repo.findMirrorExpense(co.id, 'nope')).toBeNull();
    expect(await repo.findMirrorExpense(other.id, 'e1')).toBeNull();
  });

  test('applyChangesPage writes upserts and deletes for the company and refuses a non-company account', async () => {
    const co = await account('b1', 'company');
    const other = await account('b2', 'other_business');
    expect(await repo.applyChangesPage(co.id, { upserts: [exp('e1'), exp('e2')], deletes: [], nextCursor: 'c1', generation: 2 })).toBe('applied');
    expect(await repo.applyChangesPage(co.id, { upserts: [exp('e3')], deletes: ['e1'], nextCursor: 'c2', generation: 2 })).toBe('applied');
    const rows = await repo.listMirrorExpenses(co.id, '2026-11-01', '2026-11-30');
    expect(rows.map((r) => r.externalId).sort()).toEqual(['e2', 'e3']);
    expect(rows[0]).toMatchObject({ amount: '12.30', date: '2026-11-01', categorySplits: [{ categoryId: 'c', amount: '12.30' }] });
    expect((await repo.listAccounts(userId)).find((a) => a.id === co.id)).toMatchObject({ syncCursor: 'c2', syncGeneration: 2 });

    expect(await repo.applyChangesPage(other.id, { upserts: [exp('x1')], deletes: [], nextCursor: 'c9', generation: 1 })).toBe('not_company');
    expect(await repo.listMirrorExpenses(other.id, '2026-01-01', '2026-12-31')).toHaveLength(0);
    expect((await repo.listAccounts(userId)).find((a) => a.id === other.id)!.syncCursor).toBeNull();
  });

  test('sweepGeneration removes rows of older generations', async () => {
    const co = await account('b1', 'company');
    await repo.applyChangesPage(co.id, { upserts: [exp('e1'), exp('e2')], deletes: [], nextCursor: 'c', generation: 1 });
    await repo.applyChangesPage(co.id, { upserts: [exp('e2')], deletes: [], nextCursor: 'c', generation: 2 });
    expect(await repo.sweepGeneration(co.id, 2)).toBe(1);
    expect((await repo.listMirrorExpenses(co.id, '2026-01-01', '2026-12-31')).map((r) => r.externalId)).toEqual(['e2']);
  });

  test('clearMirror removes expenses and dismissals and resets sync state; dismissals are idempotent', async () => {
    const co = await account('b1', 'company');
    await repo.applyChangesPage(co.id, { upserts: [exp('e1')], deletes: [], nextCursor: 'c1', generation: 3 });
    await repo.addDismissal(co.id, 'e1', 'x');
    await repo.addDismissal(co.id, 'e1', 'x');
    expect([...(await repo.listDismissedIds(co.id))]).toEqual(['e1']);
    await repo.clearMirror(co.id);
    expect(await repo.listMirrorExpenses(co.id, '2026-01-01', '2026-12-31')).toHaveLength(0);
    expect((await repo.listDismissedIds(co.id)).size).toBe(0);
    expect((await repo.listAccounts(userId))[0]).toMatchObject({ syncCursor: null, lastSyncedAt: null, syncGeneration: 0 });
  });

  test('replaceLabels clears the mirror of a demoted company in the same transaction', async () => {
    const co = await account('b1', 'company');
    await account('b2');
    await repo.applyChangesPage(co.id, { upserts: [exp('e1')], deletes: [], nextCursor: 'c1', generation: 1 });
    await repo.addDismissal(co.id, 'e1', null);
    await repo.replaceLabels(userId, [
      { externalId: 'b1', label: 'other_business', labelSource: 'manual' },
      { externalId: 'b2', label: 'company', labelSource: 'manual' },
    ], ['b1']);
    expect(await repo.listMirrorExpenses(co.id, '2026-01-01', '2026-12-31')).toHaveLength(0);
    expect((await repo.listDismissedIds(co.id)).size).toBe(0);
    expect((await repo.listAccounts(userId)).find((a) => a.id === co.id)).toMatchObject({ label: 'other_business', syncCursor: null });
    expect(await repo.applyChangesPage(co.id, { upserts: [exp('late')], deletes: [], nextCursor: 'z', generation: 1 })).toBe('not_company');
  });

  test('upsertMirrorExpense writes only for the company of an active connection', async () => {
    const co = await account('b1', 'company');
    const other = await account('b2', 'private');
    expect(await repo.upsertMirrorExpense(co.id, exp('w1'))).toBe('applied');
    expect(await repo.findMirrorExpense(co.id, 'w1')).toMatchObject({ amount: '12.30' });
    expect(await repo.upsertMirrorExpense(other.id, exp('w2'))).toBe('not_company');
    expect(await prisma.aiBudgetExpense.count({ where: { accountId: other.id } })).toBe(0);
    await repo.setConnectionStatus(userId, 'needs_reconnect', new Date());
    expect(await repo.upsertMirrorExpense(co.id, exp('w3'))).toBe('not_company');
    expect(await repo.findMirrorExpense(co.id, 'w3')).toBeNull();
  });

  test('deleteAccount cascades the mirror', async () => {
    const co = await account('b1', 'company');
    await repo.applyChangesPage(co.id, { upserts: [exp('e1')], deletes: [], nextCursor: 'c', generation: 1 });
    await repo.deleteAccount(co.id);
    expect(await prisma.aiBudgetExpense.count({ where: { accountId: co.id } })).toBe(0);
  });

  test('applyChangesPage writes nothing once the connection is revoked', async () => {
    const co = await account('b1', 'company');
    await repo.setConnectionStatus(userId, 'revoked', new Date());
    expect(await repo.applyChangesPage(co.id, { upserts: [exp('late')], deletes: [], nextCursor: 'z', generation: 1 })).toBe('not_company');
    expect(await prisma.aiBudgetExpense.count({ where: { accountId: co.id } })).toBe(0);
    expect((await repo.listAccounts(userId))[0].syncCursor).toBeNull();
  });

  test('clearMirror waits for an in-flight page and removes the rows that page commits', async () => {
    const co = await account('b1', 'company');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => { locked = r; });
    // Imitates applyChangesPage: takes the account row lock, writes a row, commits only after the gate.
    const page = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ai_budget_accounts" WHERE "id" = ${co.id}::uuid FOR UPDATE`;
      await tx.aiBudgetExpense.create({
        data: {
          accountId: co.id, externalId: 'inflight', amount: '1.00', currency: 'PLN', date: new Date('2026-11-01T00:00:00Z'),
          remoteUpdatedAt: new Date(), syncGeneration: 1,
        },
      });
      locked();
      await gate;
    }, { timeout: 20000 });
    await lockTaken;
    let cleared = false;
    const clearing = repo.clearMirror(co.id).then(() => { cleared = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(cleared).toBe(false);
    release();
    await page;
    await clearing;
    expect(await prisma.aiBudgetExpense.count({ where: { accountId: co.id } })).toBe(0);
  });

  test('a revoked connection keeps its status and accepts no token update', async () => {
    const conn = (await repo.getConnection(userId))!;
    await repo.setConnectionStatus(userId, 'revoked', new Date());
    await repo.setConnectionStatus(userId, 'needs_reconnect', new Date());
    expect(await repo.updateTokens(conn.id, 'r', { accessTokenEnc: 'x', refreshTokenEnc: 'y', accessTokenExpiresAt: new Date(), scope: 's' })).toBe(false);
    expect(await repo.getConnection(userId)).toMatchObject({ status: 'revoked', accessTokenEnc: 'a', refreshTokenEnc: 'r' });
    // A reconnect (code exchange) still reactivates it.
    await repo.upsertConnectionTokens(userId, { accessTokenEnc: 'n', refreshTokenEnc: 'm', accessTokenExpiresAt: new Date(), scope: 's' });
    expect((await repo.getConnection(userId))!.status).toBe('active');
  });

  test('updateTokens is a compare-and-swap on the refresh token the refresher read', async () => {
    const conn = (await repo.getConnection(userId))!;
    const next = { accessTokenEnc: 'a2', refreshTokenEnc: 'r2', accessTokenExpiresAt: new Date(), scope: 's' };
    expect(await repo.updateTokens(conn.id, 'stale', next)).toBe(false);
    expect(await repo.getConnection(userId)).toMatchObject({ refreshTokenEnc: 'r' });
    expect(await repo.updateTokens(conn.id, 'r', next)).toBe(true);
    expect(await repo.getConnection(userId)).toMatchObject({ accessTokenEnc: 'a2', refreshTokenEnc: 'r2' });
  });

  test('listActiveConnections skips soft-deleted users', async () => {
    expect((await repo.listActiveConnections()).some((c) => c.userId === userId)).toBe(true);
    await prisma.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });
    expect((await repo.listActiveConnections()).some((c) => c.userId === userId)).toBe(false);
  });
});
