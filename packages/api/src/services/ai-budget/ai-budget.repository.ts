import { Prisma, PrismaClient } from '@prisma/client';
import type { AiBudgetLabel, AiBudgetLabelSource } from './ai-budget.types';
import type { ConnectionRow, StoredTokens, TokenStore } from './ai-budget-token.manager';

export interface AccountRow {
  id: string;
  connectionId: string;
  userId: string;
  externalId: string;
  /** Empty when AI Budget hides the name (grantor no longer a member); the UI localizes it. */
  name: string;
  type: string;
  currency: string;
  access: 'read' | 'read_write';
  active: boolean;
  inactiveReason: string | null;
  label: AiBudgetLabel;
  labelSource: AiBudgetLabelSource;
  syncCursor: string | null;
  syncGeneration: number;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
  fullResyncAt: Date | null;
}

export interface MirrorExpenseInput {
  externalId: string;
  amount: string;
  currency: string;
  date: string;
  categoryId: string | null;
  categorySplits: { categoryId: string; amount: string }[];
  merchant: string | null;
  description: string | null;
  isDebt: boolean;
  isSplitReceivable: boolean;
  remoteUpdatedAt: Date;
}
export interface MirrorExpenseRow extends MirrorExpenseInput { accountId: string }

export type AccountUpsert = Pick<AccountRow, 'externalId' | 'name' | 'type' | 'currency' | 'access' | 'active' | 'inactiveReason' | 'label' | 'labelSource'>;

export interface AiBudgetRepository extends TokenStore {
  setNeedsCompanyChoice(userId: string, value: boolean): Promise<void>;
  /** Tokens become null, status revoked. */
  clearTokens(userId: string): Promise<void>;
  listActiveConnections(): Promise<ConnectionRow[]>;
  listReconnectOlderThan(cutoff: Date): Promise<ConnectionRow[]>;
  listAccounts(userId: string): Promise<AccountRow[]>;
  /**
   * One transaction, demote before promote (the one-company index). `clearMirrorExternalIds` lists accounts
   * (by external id) whose mirror, dismissals and sync state are cleared in the SAME transaction.
   */
  replaceLabels(userId: string, labels: { externalId: string; label: AiBudgetLabel; labelSource: AiBudgetLabelSource }[], clearMirrorExternalIds?: string[]): Promise<void>;
  upsertAccount(connectionId: string, userId: string, a: AccountUpsert): Promise<AccountRow>;
  updateAccountSync(accountId: string, patch: Partial<Pick<AccountRow, 'syncCursor' | 'syncGeneration' | 'lastSyncedAt' | 'lastSyncError' | 'fullResyncAt'>>): Promise<void>;
  /** Cascades mirror + dismissals. */
  deleteAccount(accountId: string): Promise<void>;
  /** Deletes expenses + dismissals; cursor/lastSyncedAt/fullResyncAt null, generation 0. Waits for an in-flight page. */
  clearMirror(accountId: string): Promise<void>;
  /** 'not_company' (nothing written) unless the account is company AND the connection is active. */
  applyChangesPage(accountId: string, page: { upserts: MirrorExpenseInput[]; deletes: string[]; nextCursor: string; generation: number }): Promise<'applied' | 'not_company'>;
  /** Deletes mirror rows whose generation is older than `generation`. Returns the count. */
  sweepGeneration(accountId: string, generation: number): Promise<number>;
  listMirrorExpenses(accountId: string, from: string, to: string): Promise<MirrorExpenseRow[]>;
  /** One mirror row by its remote id, or null. */
  findMirrorExpense(accountId: string, externalId: string): Promise<MirrorExpenseRow | null>;
  /** Like applyChangesPage: 'not_company' (nothing written) unless the account is company AND the connection is active. */
  upsertMirrorExpense(accountId: string, e: MirrorExpenseInput): Promise<'applied' | 'not_company'>;
  deleteMirrorExpense(accountId: string, externalId: string): Promise<void>;
  listDismissedIds(accountId: string): Promise<Set<string>>;
  /** Idempotent. */
  addDismissal(accountId: string, externalExpenseId: string, reason: string | null): Promise<void>;
}

const toConnection = (c: {
  id: string; userId: string; accessTokenEnc: string | null; refreshTokenEnc: string | null; accessTokenExpiresAt: Date | null;
  scope: string | null; status: ConnectionRow['status']; statusChangedAt: Date; needsCompanyChoice: boolean;
}): ConnectionRow => ({
  id: c.id, userId: c.userId, accessTokenEnc: c.accessTokenEnc, refreshTokenEnc: c.refreshTokenEnc,
  accessTokenExpiresAt: c.accessTokenExpiresAt, scope: c.scope, status: c.status, statusChangedAt: c.statusChangedAt,
  needsCompanyChoice: c.needsCompanyChoice,
});

type DbAccount = Awaited<ReturnType<PrismaClient['aiBudgetAccount']['findFirstOrThrow']>>;
const toAccount = (a: DbAccount): AccountRow => ({
  id: a.id, connectionId: a.connectionId, userId: a.userId, externalId: a.externalId, name: a.name, type: a.type,
  currency: a.currency, access: a.access as AccountRow['access'], active: a.active, inactiveReason: a.inactiveReason,
  label: a.label, labelSource: a.labelSource, syncCursor: a.syncCursor, syncGeneration: a.syncGeneration,
  lastSyncedAt: a.lastSyncedAt, lastSyncError: a.lastSyncError, fullResyncAt: a.fullResyncAt,
});

const toDate = (ymd: string): Date => new Date(`${ymd}T00:00:00.000Z`);
const toYmd = (d: Date): string => d.toISOString().slice(0, 10);

type DbExpense = Awaited<ReturnType<PrismaClient['aiBudgetExpense']['findFirstOrThrow']>>;
const toMirrorRow = (r: DbExpense): MirrorExpenseRow => ({
  accountId: r.accountId, externalId: r.externalId, amount: r.amount.toFixed(2), currency: r.currency, date: toYmd(r.date),
  categoryId: r.categoryId, categorySplits: r.categorySplits as unknown as MirrorExpenseInput['categorySplits'],
  merchant: r.merchant, description: r.description, isDebt: r.isDebt, isSplitReceivable: r.isSplitReceivable,
  remoteUpdatedAt: r.remoteUpdatedAt,
});

function expenseData(e: MirrorExpenseInput, generation?: number) {
  return {
    amount: new Prisma.Decimal(e.amount), currency: e.currency, date: toDate(e.date), categoryId: e.categoryId,
    categorySplits: e.categorySplits as unknown as Prisma.InputJsonValue, merchant: e.merchant, description: e.description,
    isDebt: e.isDebt, isSplitReceivable: e.isSplitReceivable, remoteUpdatedAt: e.remoteUpdatedAt,
    ...(generation === undefined ? {} : { syncGeneration: generation }),
  };
}

export class PrismaAiBudgetRepository implements AiBudgetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getConnection(userId: string): Promise<ConnectionRow | null> {
    const c = await this.prisma.aiBudgetConnection.findUnique({ where: { userId } });
    return c ? toConnection(c) : null;
  }

  async upsertConnectionTokens(userId: string, t: StoredTokens): Promise<ConnectionRow> {
    const data = { ...t, status: 'active' as const, statusChangedAt: new Date() };
    return toConnection(await this.prisma.aiBudgetConnection.upsert({ where: { userId }, create: { userId, ...data }, update: data }));
  }

  /**
   * Compare-and-swap on the refresh token the refresher read. No-op once the connection is revoked
   * (a refresh that raced a disconnect must not bring tokens back) or after a newer save (reconnect).
   */
  async updateTokens(connectionId: string, previousRefreshTokenEnc: string, t: StoredTokens): Promise<boolean> {
    const r = await this.prisma.aiBudgetConnection.updateMany({
      where: { id: connectionId, status: { not: 'revoked' }, refreshTokenEnc: previousRefreshTokenEnc },
      data: { ...t },
    });
    return r.count > 0;
  }

  /** Only `revoked` may overwrite `revoked` (a disconnect wins over a racing refresh's needs_reconnect). */
  async setConnectionStatus(userId: string, status: ConnectionRow['status'], at: Date): Promise<void> {
    await this.prisma.aiBudgetConnection.updateMany({
      where: status === 'revoked' ? { userId } : { userId, status: { not: 'revoked' } },
      data: { status, statusChangedAt: at },
    });
  }

  async setNeedsCompanyChoice(userId: string, value: boolean): Promise<void> {
    await this.prisma.aiBudgetConnection.updateMany({ where: { userId }, data: { needsCompanyChoice: value } });
  }

  async clearTokens(userId: string): Promise<void> {
    await this.prisma.aiBudgetConnection.updateMany({
      where: { userId },
      data: { accessTokenEnc: null, refreshTokenEnc: null, accessTokenExpiresAt: null, status: 'revoked', statusChangedAt: new Date() },
    });
  }

  /** Active connections of users who are not soft-deleted: a deleted user's data is not synced. */
  async listActiveConnections(): Promise<ConnectionRow[]> {
    return (await this.prisma.aiBudgetConnection.findMany({ where: { status: 'active', user: { deletedAt: null } } })).map(toConnection);
  }

  async listReconnectOlderThan(cutoff: Date): Promise<ConnectionRow[]> {
    return (await this.prisma.aiBudgetConnection.findMany({ where: { status: 'needs_reconnect', statusChangedAt: { lt: cutoff } } })).map(toConnection);
  }

  async listAccounts(userId: string): Promise<AccountRow[]> {
    return (await this.prisma.aiBudgetAccount.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })).map(toAccount);
  }

  async replaceLabels(userId: string, labels: { externalId: string; label: AiBudgetLabel; labelSource: AiBudgetLabelSource }[], clearMirrorExternalIds: string[] = []): Promise<void> {
    const ordered = [...labels.filter((l) => l.label !== 'company'), ...labels.filter((l) => l.label === 'company')];
    await this.prisma.$transaction(async (tx) => {
      for (const l of ordered) {
        await tx.aiBudgetAccount.updateMany({ where: { userId, externalId: l.externalId }, data: { label: l.label, labelSource: l.labelSource } });
      }
      if (clearMirrorExternalIds.length) {
        const ids = (await tx.aiBudgetAccount.findMany({ where: { userId, externalId: { in: clearMirrorExternalIds } }, select: { id: true } })).map((a) => a.id);
        await tx.aiBudgetExpense.deleteMany({ where: { accountId: { in: ids } } });
        await tx.aiBudgetReconciliationDismissal.deleteMany({ where: { accountId: { in: ids } } });
        await tx.aiBudgetAccount.updateMany({ where: { id: { in: ids } }, data: { syncCursor: null, lastSyncedAt: null, fullResyncAt: null, syncGeneration: 0 } });
      }
    });
  }

  async upsertAccount(connectionId: string, userId: string, a: AccountUpsert): Promise<AccountRow> {
    const { externalId, ...fields } = a;
    return toAccount(await this.prisma.aiBudgetAccount.upsert({
      where: { connectionId_externalId: { connectionId, externalId } },
      create: { connectionId, userId, externalId, ...fields },
      update: fields,
    }));
  }

  async updateAccountSync(accountId: string, patch: Partial<Pick<AccountRow, 'syncCursor' | 'syncGeneration' | 'lastSyncedAt' | 'lastSyncError' | 'fullResyncAt'>>): Promise<void> {
    await this.prisma.aiBudgetAccount.updateMany({ where: { id: accountId }, data: patch });
  }

  async deleteAccount(accountId: string): Promise<void> {
    await this.prisma.aiBudgetAccount.deleteMany({ where: { id: accountId } });
  }

  async clearMirror(accountId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // The account row first: this waits on an in-flight applyChangesPage's row lock, so the deletes
      // below see (and remove) every row that page commits.
      await tx.aiBudgetAccount.updateMany({
        where: { id: accountId },
        data: { syncCursor: null, lastSyncedAt: null, fullResyncAt: null, syncGeneration: 0 },
      });
      await tx.aiBudgetExpense.deleteMany({ where: { accountId } });
      await tx.aiBudgetReconciliationDismissal.deleteMany({ where: { accountId } });
    });
  }

  async applyChangesPage(
    accountId: string,
    page: { upserts: MirrorExpenseInput[]; deletes: string[]; nextCursor: string; generation: number },
  ): Promise<'applied' | 'not_company'> {
    return this.prisma.$transaction(
      async (tx) => {
        // First statement: lock the account row, only while it is the company of an ACTIVE connection.
        // A concurrent relabel or disconnect (and its mirror clear) waits until this page commits, and a
        // page for a non-company account or a disconnected connection writes nothing. After waiting on
        // the lock, Postgres re-checks the account's conditions on its latest version.
        const lockedRows = await tx.$queryRaw<{ id: string }[]>`
          SELECT a."id" FROM "ai_budget_accounts" a
          JOIN "ai_budget_connections" c ON c."id" = a."connectionId"
          WHERE a."id" = ${accountId}::uuid AND a."label" = 'company' AND c."status" = 'active'
          FOR UPDATE OF a`;
        if (lockedRows.length === 0) return 'not_company' as const;
        // lastSyncedAt is NOT stamped here: it marks a finished run, so a partial first sync never reads as ready.
        await tx.aiBudgetAccount.updateMany({
          where: { id: accountId },
          data: { syncCursor: page.nextCursor, syncGeneration: page.generation },
        });
        for (const e of page.upserts) {
          await tx.aiBudgetExpense.upsert({
            where: { accountId_externalId: { accountId, externalId: e.externalId } },
            create: { accountId, externalId: e.externalId, ...expenseData(e, page.generation) },
            update: expenseData(e, page.generation),
          });
        }
        if (page.deletes.length) await tx.aiBudgetExpense.deleteMany({ where: { accountId, externalId: { in: page.deletes } } });
        return 'applied' as const;
      },
      { timeout: 30000, maxWait: 10000 },
    );
  }

  async sweepGeneration(accountId: string, generation: number): Promise<number> {
    return (await this.prisma.aiBudgetExpense.deleteMany({ where: { accountId, syncGeneration: { lt: generation } } })).count;
  }

  async listMirrorExpenses(accountId: string, from: string, to: string): Promise<MirrorExpenseRow[]> {
    const rows = await this.prisma.aiBudgetExpense.findMany({
      where: { accountId, date: { gte: toDate(from), lte: toDate(to) } },
      orderBy: [{ date: 'asc' }, { externalId: 'asc' }],
    });
    return rows.map(toMirrorRow);
  }

  async findMirrorExpense(accountId: string, externalId: string): Promise<MirrorExpenseRow | null> {
    const r = await this.prisma.aiBudgetExpense.findUnique({ where: { accountId_externalId: { accountId, externalId } } });
    return r ? toMirrorRow(r) : null;
  }

  async upsertMirrorExpense(accountId: string, e: MirrorExpenseInput): Promise<'applied' | 'not_company'> {
    return this.prisma.$transaction(async (tx) => {
      // Same guard as applyChangesPage: lock the row only while it is the company of an active connection,
      // so an account relabelled away from company (or a disconnect) can never receive a mirror row.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT a."id" FROM "ai_budget_accounts" a
        JOIN "ai_budget_connections" c ON c."id" = a."connectionId"
        WHERE a."id" = ${accountId}::uuid AND a."label" = 'company' AND c."status" = 'active'
        FOR UPDATE OF a`;
      if (locked.length === 0) return 'not_company' as const;
      await tx.aiBudgetExpense.upsert({
        where: { accountId_externalId: { accountId, externalId: e.externalId } },
        create: { accountId, externalId: e.externalId, ...expenseData(e) },
        update: expenseData(e),
      });
      return 'applied' as const;
    });
  }

  async deleteMirrorExpense(accountId: string, externalId: string): Promise<void> {
    await this.prisma.aiBudgetExpense.deleteMany({ where: { accountId, externalId } });
  }

  async listDismissedIds(accountId: string): Promise<Set<string>> {
    const rows = await this.prisma.aiBudgetReconciliationDismissal.findMany({ where: { accountId }, select: { externalExpenseId: true } });
    return new Set(rows.map((r) => r.externalExpenseId));
  }

  async addDismissal(accountId: string, externalExpenseId: string, reason: string | null): Promise<void> {
    await this.prisma.aiBudgetReconciliationDismissal.upsert({
      where: { accountId_externalExpenseId: { accountId, externalExpenseId } },
      create: { accountId, externalExpenseId, reason },
      update: {},
    });
  }
}
