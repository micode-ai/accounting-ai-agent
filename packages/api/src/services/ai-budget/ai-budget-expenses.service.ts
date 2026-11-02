import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger';
import { attributeToCategories, toCents } from './ai-budget.domain';
import type { AccountRow, AiBudgetRepository, MirrorExpenseRow } from './ai-budget.repository';
import type { AiBudgetLabel, PublicExpenseWire, RemoteCategory } from './ai-budget.types';
import type { AiBudgetAccountsService } from './ai-budget-accounts.service';
import type { AiBudgetApiClient, ExpenseCreateBody, ExpenseUpdateBody } from './ai-budget-api.client';
import { AiBudgetApiError } from './ai-budget-errors';
import type { AiBudgetLiveReadService } from './ai-budget-live.service';
import type { AiBudgetReconciliationService } from './ai-budget-reconciliation.service';
import { toMirrorInput, type AiBudgetMirrorSyncService } from './ai-budget-sync.service';

/** How long a chat read waits for the on-demand company sync before answering from the mirror. */
export const CHAT_SYNC_BOUND_MS = 8000;

export interface ExpenseView {
  id: string;
  accountExternalId: string;
  accountName: string;
  label: AiBudgetLabel;
  date: string;
  amountCents: number;
  currency: string;
  categoryId: string | null;
  categorySplits: { categoryId: string | null; amountCents: number }[];
  /** null when absent or encrypted in AI Budget. */
  merchant: string | null;
  description: string | null;
  isDebt: boolean;
  isSplitReceivable: boolean;
  /**
   * Set only when a category filter was applied: the part of the amount attributed to that category
   * (splits decide when present). Totals use it instead of amountCents.
   */
  matchedCents?: number;
}

/**
 * `categoryName` is matched case-insensitively against each account's own categories (ids differ per account).
 * `text` is matched locally on merchant and description, for the mirror and live accounts alike: it is never
 * sent to AI Budget (its `search` covers description and notes only, and would make the two disagree).
 */
export interface ExpenseQuery { accounts: AccountRow[]; dateFrom: string; dateTo: string; categoryName?: string; text?: string }

export interface ExpenseQueryResult {
  expenses: ExpenseView[];
  truncated: boolean;
  /** Last successful sync of the company mirror that was read; null when no company account was read or it never synced. */
  companyAsOf: Date | null;
  /** The company sync is still running (or never finished): company figures may be missing or stale. */
  companyPending: boolean;
  /** The company never synced successfully and its last sync failed: its figures are unknown. */
  companySyncFailed: boolean;
  /** Accounts that could not be read; their figures are unknown, not zero. */
  failed: { accountExternalId: string; code: string }[];
  /** Accounts (external ids) where a text search could not see encrypted merchant/description fields. */
  searchLimited: string[];
  /**
   * Set only when every read account's categories loaded and none has `categoryName`: the available expense category
   * names (sorted, deduplicated), so the answer can list them instead of reporting "no expenses".
   */
  unknownCategory?: string[];
}

export type WriteRefusalReason = 'read_only' | 'inactive' | 'unknown_account' | 'unknown_category';

export class AiBudgetWriteRefused extends Error {
  constructor(readonly reason: WriteRefusalReason, readonly available: string[] = []) {
    super(`AI Budget write refused: ${reason}`);
    this.name = 'AiBudgetWriteRefused';
  }
}

export interface AiBudgetExpensesDeps {
  repo: AiBudgetRepository;
  accounts: Pick<AiBudgetAccountsService, 'getCompanyAccount'>;
  sync: Pick<AiBudgetMirrorSyncService, 'syncIfStale'>;
  live: Pick<AiBudgetLiveReadService, 'listExpenses' | 'listCategories' | 'invalidate'>;
  api: Pick<AiBudgetApiClient, 'createExpense' | 'updateExpense' | 'deleteExpense'>;
  /** Busts the cached dashboard reconciliation after a company write. */
  reconciliation?: Pick<AiBudgetReconciliationService, 'invalidate'>;
  syncBoundMs?: number;
}

/** companyOnly: a shared-org-chat write; any account that is not (or no longer) the company is refused as unknown. */
export interface WriteOptions { companyOnly?: boolean }

export interface ExpenseCreateInput { amount: string; date: string; currency?: string; categoryName?: string; merchant?: string; description?: string }
export interface ExpensePatch {
  amount?: string; date?: string; currency?: string; categoryName?: string | null; merchant?: string | null; description?: string | null;
}

const isReadable = (a: AccountRow): boolean => a.active && a.type !== '';

function fromMirror(r: MirrorExpenseRow, a: AccountRow): ExpenseView {
  return {
    id: r.externalId, accountExternalId: a.externalId, accountName: a.name, label: a.label, date: r.date,
    amountCents: toCents(r.amount), currency: r.currency, categoryId: r.categoryId,
    categorySplits: r.categorySplits.map((s) => ({ categoryId: s.categoryId, amountCents: toCents(s.amount) })),
    merchant: r.merchant, description: r.description, isDebt: r.isDebt, isSplitReceivable: r.isSplitReceivable,
  };
}

function fromWire(e: PublicExpenseWire, a: AccountRow): ExpenseView {
  return {
    id: e.id, accountExternalId: a.externalId, accountName: a.name, label: a.label, date: e.date,
    amountCents: toCents(e.amount), currency: e.currency, categoryId: e.category_id,
    categorySplits: e.category_splits.map((s) => ({ categoryId: s.category_id, amountCents: toCents(s.amount) })),
    merchant: e.merchant, description: e.description, isDebt: e.is_debt, isSplitReceivable: e.is_split_receivable,
  };
}

const matchesText = (e: { merchant: string | null; description: string | null }, text: string): boolean => {
  const needle = text.trim().toLowerCase();
  return [e.merchant, e.description].some((f) => f !== null && f.toLowerCase().includes(needle));
};

const normName = (s: string): string => s.trim().toLowerCase();

/**
 * Keeps the expenses attributed to one of the categories and records the attributed share. Splits decide when
 * present (the own category is then ignored); otherwise the own category takes the whole amount.
 */
function filterByCategory(rows: ExpenseView[], categoryIds: Set<string>): ExpenseView[] {
  return rows.flatMap((r) => {
    const parts = attributeToCategories(r).filter((c) => c.categoryId !== null && categoryIds.has(c.categoryId));
    return parts.length ? [{ ...r, matchedCents: parts.reduce((sum, c) => sum + c.amountCents, 0) }] : [];
  });
}

const byDateDesc = (a: ExpenseView, b: ExpenseView): number => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : 1);

/**
 * Chat-facing reads and writes of AI Budget expenses. Company reads come from the mirror (after a bounded
 * on-demand sync); every other account is read live (Redis-cached ciphertext, never the DB). Writes go to
 * AI Budget first; a company write then updates the mirror from the response, any other write invalidates
 * that account's live cache. Nothing from an expense payload is ever logged here.
 */
export class AiBudgetExpensesService {
  private readonly syncBoundMs: number;

  constructor(private readonly deps: AiBudgetExpensesDeps) {
    this.syncBoundMs = deps.syncBoundMs ?? CHAT_SYNC_BOUND_MS;
  }

  /**
   * Waits at most the bound for the company sync; a sync that runs longer keeps going in the background.
   * Returns the company row as it stands afterwards and whether its data may be incomplete.
   */
  async ensureCompanyFresh(userId: string): Promise<{ company: AccountRow | null; pending: boolean; syncFailed: boolean }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = this.deps.sync.syncIfStale(userId).then(
      (outcome): string => outcome,
      (err: unknown): string => {
        logger.warn('AI Budget chat sync failed', { userId, error: (err as Error)?.name ?? 'unknown' });
        return 'failed';
      },
    );
    const bound = new Promise<string>((resolve) => { timer = setTimeout(() => resolve('timeout'), this.syncBoundMs); });
    const outcome = await Promise.race([run, bound]);
    if (timer) clearTimeout(timer);
    const company = await this.deps.accounts.getCompanyAccount(userId);
    // Never synced: a sync still running (bound exceeded, or another run holds the lock) is pending; a sync
    // that ended without any success is failed, never "syncing" forever.
    const stillRunning = outcome === 'timeout' || outcome === 'skipped_locked';
    const syncFailed = !!company && !company.lastSyncedAt && !stillRunning && (outcome === 'failed' || !!company.lastSyncError);
    return { company, pending: !syncFailed && (stillRunning || !company?.lastSyncedAt), syncFailed };
  }

  async query(userId: string, q: ExpenseQuery): Promise<ExpenseQueryResult> {
    const result: ExpenseQueryResult = { expenses: [], truncated: false, companyAsOf: null, companyPending: false, companySyncFailed: false, failed: [], searchLimited: [] };
    const readable = q.accounts.filter(isReadable);
    const available = new Set<string>();
    let categoryFound = false;
    // A category list that failed to load leaves "is there such a category?" unknown: never report it as absent.
    let categoriesFailed = false;
    /** Ids of the account's categories named `q.categoryName`; throws when the categories cannot be read. */
    const categoryIds = async (acc: AccountRow): Promise<Set<string>> => {
      let all;
      try {
        all = await this.deps.live.listCategories(userId, acc);
      } catch (err) {
        categoriesFailed = true;
        throw err;
      }
      const cats = all.filter((c) => c.type !== 'income' && c.name !== null);
      const wanted = normName(q.categoryName as string);
      const ids = new Set(cats.filter((c) => normName(c.name as string) === wanted).map((c) => c.id));
      for (const c of cats) available.add((c.name as string).trim());
      if (ids.size) categoryFound = true;
      return ids;
    };

    for (const acc of readable.filter((a) => a.label === 'company')) {
      const { company, pending, syncFailed } = await this.ensureCompanyFresh(userId);
      // The row read after the sync decides: a company relabelled meanwhile is not read from the mirror.
      if (!company || company.id !== acc.id) continue;
      result.companyAsOf = company.lastSyncedAt;
      result.companyPending = pending;
      result.companySyncFailed = syncFailed;
      let ids: Set<string> | null = null;
      if (q.categoryName) {
        try {
          ids = await categoryIds(company);
        } catch (err) {
          const code = err instanceof AiBudgetApiError ? err.code : 'unknown';
          logger.warn('AI Budget chat categories unavailable', { userId, code });
          result.failed.push({ accountExternalId: company.externalId, code });
          continue;
        }
      }
      let rows = (await this.deps.repo.listMirrorExpenses(company.id, q.dateFrom, q.dateTo)).map((r) => fromMirror(r, company));
      if (ids) rows = filterByCategory(rows, ids);
      if (q.text) rows = rows.filter((r) => matchesText(r, q.text as string));
      result.expenses.push(...rows);
    }

    for (const acc of readable.filter((a) => a.label !== 'company')) {
      // No server-side category or text filter: the window is read whole (cached per account for 300 s) and
      // attribution (splits decide) and the text match are applied here, exactly as for the mirror.
      try {
        const ids = q.categoryName ? await categoryIds(acc) : null;
        const res = await this.deps.live.listExpenses(userId, acc, { dateFrom: q.dateFrom, dateTo: q.dateTo });
        let rows = res.expenses.map((e) => fromWire(e, acc));
        if (q.text) {
          const hidden = res.expenses.some((e) => e.encrypted_fields.includes('merchant') || e.encrypted_fields.includes('description'));
          if (hidden) result.searchLimited.push(acc.externalId);
          rows = rows.filter((r) => matchesText(r, q.text as string));
        }
        if (ids) rows = filterByCategory(rows, ids);
        result.truncated = result.truncated || res.truncated;
        result.expenses.push(...rows);
      } catch (err) {
        const code = err instanceof AiBudgetApiError ? err.code : 'unknown';
        logger.warn('AI Budget chat read failed', { userId, code });
        result.failed.push({ accountExternalId: acc.externalId, code });
      }
    }

    if (q.categoryName && !categoryFound && !categoriesFailed) {
      result.unknownCategory = [...available].sort((a, b) => a.localeCompare(b));
    }
    result.expenses.sort(byDateDesc);
    return result;
  }

  /** Categories of one readable account (cached, encrypted in Redis). */
  listCategories(userId: string, account: AccountRow): Promise<RemoteCategory[]> {
    return this.deps.live.listCategories(userId, account);
  }

  async create(userId: string, accountRowId: string, input: ExpenseCreateInput, opts: WriteOptions = {}): Promise<ExpenseView> {
    const row = await this.writableAccount(userId, accountRowId, opts);
    const body: ExpenseCreateBody = { amount: input.amount, date: input.date };
    if (input.currency) body.currency = input.currency;
    if (input.categoryName !== undefined) body.category_id = await this.resolveCategory(userId, row, input.categoryName);
    if (input.merchant !== undefined) body.merchant = input.merchant;
    if (input.description !== undefined) body.description = input.description;

    const key = randomUUID();
    let created: PublicExpenseWire;
    try {
      created = await this.deps.api.createExpense(userId, row.externalId, body, key);
    } catch (err) {
      // A timeout or network failure leaves the outcome unknown: one retry with the same key cannot double-create.
      if (!(err instanceof AiBudgetApiError && err.status === 0)) throw err;
      created = await this.deps.api.createExpense(userId, row.externalId, body, key);
    }
    return this.afterWrite(userId, row, created);
  }

  async update(userId: string, accountRowId: string, expenseId: string, patch: ExpensePatch, opts: WriteOptions = {}): Promise<ExpenseView> {
    const row = await this.writableAccount(userId, accountRowId, opts);
    const body: ExpenseUpdateBody = {};
    if (patch.amount !== undefined) body.amount = patch.amount;
    if (patch.date !== undefined) body.date = patch.date;
    if (patch.currency !== undefined) body.currency = patch.currency;
    if (patch.categoryName !== undefined) {
      body.category_id = patch.categoryName === null ? null : await this.resolveCategory(userId, row, patch.categoryName);
    }
    if (patch.merchant !== undefined) body.merchant = patch.merchant;
    if (patch.description !== undefined) body.description = patch.description;
    const updated = await this.deps.api.updateExpense(userId, row.externalId, expenseId, body);
    return this.afterWrite(userId, row, updated);
  }

  async remove(userId: string, accountRowId: string, expenseId: string, opts: WriteOptions = {}): Promise<void> {
    const row = await this.writableAccount(userId, accountRowId, opts);
    try {
      await this.deps.api.deleteExpense(userId, row.externalId, expenseId);
    } catch (err) {
      // Already gone in AI Budget: the mirror must not keep it either. The caller still learns it was not found.
      if (row.label === 'company' && err instanceof AiBudgetApiError && err.status === 404) await this.afterCompanyDelete(userId, row, expenseId);
      throw err;
    }
    if (row.label === 'company') await this.afterCompanyDelete(userId, row, expenseId);
    else await this.invalidate(userId, row.id);
  }

  private async afterCompanyDelete(userId: string, row: AccountRow, expenseId: string): Promise<void> {
    // Deleting a mirror row is always safe; the live cache is dropped too in case the account was relabelled meanwhile.
    await this.deps.repo.deleteMirrorExpense(row.id, expenseId);
    await this.deps.reconciliation?.invalidate(userId);
    await this.invalidate(userId, row.id);
  }

  private async afterWrite(userId: string, row: AccountRow, e: PublicExpenseWire): Promise<ExpenseView> {
    // The repository writes only while the row is the company of an active connection (row lock), so an
    // account relabelled away from company during the HTTP call never gets a DB row; it gets an invalidate.
    if (row.label === 'company' && (await this.deps.repo.upsertMirrorExpense(row.id, toMirrorInput(e))) === 'applied') {
      await this.deps.reconciliation?.invalidate(userId);
    } else {
      await this.invalidate(userId, row.id);
    }
    return fromWire(e, row);
  }

  private async invalidate(userId: string, accountRowId: string): Promise<void> {
    try {
      await this.deps.live.invalidate(userId, accountRowId);
    } catch {
      logger.warn('AI Budget live cache invalidation failed', { userId });
    }
  }

  private async writableAccount(userId: string, accountRowId: string, opts: WriteOptions): Promise<AccountRow> {
    const row = (await this.deps.repo.listAccounts(userId)).find((a) => a.id === accountRowId);
    if (!row || (opts.companyOnly && row.label !== 'company')) throw new AiBudgetWriteRefused('unknown_account');
    if (!isReadable(row)) throw new AiBudgetWriteRefused('inactive');
    if (row.access !== 'read_write') throw new AiBudgetWriteRefused('read_only');
    return row;
  }

  private async resolveCategory(userId: string, row: AccountRow, name: string): Promise<string> {
    const cats = (await this.deps.live.listCategories(userId, row)).filter((c) => c.type !== 'income' && c.name !== null);
    const wanted = name.trim().toLowerCase();
    const hit = cats.find((c) => (c.name as string).trim().toLowerCase() === wanted);
    if (!hit) throw new AiBudgetWriteRefused('unknown_category', cats.map((c) => c.name as string));
    return hit.id;
  }
}
