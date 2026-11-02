import { randomUUID } from 'crypto';
import type { RedisLike } from '../../lib/redis';
import { logger } from '../../utils/logger';
import type { AiBudgetAccountsService } from './ai-budget-accounts.service';
import type { AiBudgetApiClient, ChangesPage } from './ai-budget-api.client';
import { AiBudgetApiError, AiBudgetNotConnectedError, AiBudgetReconnectRequiredError } from './ai-budget-errors';
import type { AccountRow, AiBudgetRepository, MirrorExpenseInput } from './ai-budget.repository';
import type { PublicExpenseWire } from './ai-budget.types';

export type SyncOutcome = 'synced' | 'skipped_locked' | 'no_company' | 'needs_reconnect' | 'failed' | 'aborted_relabelled';
export const FULL_RESYNC_INTERVAL_MS = 7 * 24 * 3600_000;
export const SYNC_LOCK_TTL_MS = 120_000;
const DEFAULT_STALE_MS = 300_000;

export function toMirrorInput(e: PublicExpenseWire): MirrorExpenseInput {
  return {
    externalId: e.id,
    amount: e.amount,
    currency: e.currency,
    date: e.date,
    categoryId: e.category_id,
    categorySplits: e.category_splits.map((s) => ({ categoryId: s.category_id, amount: s.amount })),
    merchant: e.merchant,
    description: e.description,
    isDebt: e.is_debt,
    isSplitReceivable: e.is_split_receivable,
    remoteUpdatedAt: new Date(e.updated_at),
  };
}

/** Short, content-free failure code stored in lastSyncError. */
function errorCode(err: unknown): string {
  if (err instanceof AiBudgetApiError) {
    if (err.status >= 500) return 'unavailable';
    if (err.status === 429) return 'rate_limited';
    return err.code;
  }
  return 'unknown';
}

/** Keeps the company account's mirror current from the AI Budget changes feed. */
export class AiBudgetMirrorSyncService {
  constructor(
    private readonly repo: AiBudgetRepository,
    private readonly accounts: AiBudgetAccountsService,
    private readonly api: AiBudgetApiClient,
    private readonly redis: RedisLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async syncIfStale(userId: string, maxAgeMs: number = DEFAULT_STALE_MS): Promise<SyncOutcome | 'fresh'> {
    const company = await this.accounts.getCompanyAccount(userId);
    if (!company) return 'no_company';
    if (company.lastSyncedAt && this.now().getTime() - company.lastSyncedAt.getTime() < maxAgeMs) return 'fresh';
    return this.syncCompany(userId);
  }

  async syncCompany(userId: string, opts: { fullResync?: boolean } = {}): Promise<SyncOutcome> {
    const company = await this.accounts.getCompanyAccount(userId);
    if (!company) return 'no_company';

    const lockKey = `aib:sync:${company.id}`;
    const lockValue = randomUUID();
    if (!(await this.redis.setNxPx(lockKey, lockValue, SYNC_LOCK_TTL_MS))) return 'skipped_locked';
    try {
      return await this.run(userId, company, !!opts.fullResync);
    } catch (err) {
      if (err instanceof AiBudgetReconnectRequiredError) return 'needs_reconnect';
      if (err instanceof AiBudgetNotConnectedError) return 'no_company';
      const code = errorCode(err);
      logger.warn('AI Budget mirror sync failed', { userId, code });
      try {
        await this.repo.updateAccountSync(company.id, { lastSyncError: code });
      } catch {
        logger.warn('AI Budget mirror sync could not record its error', { userId });
      }
      return 'failed';
    } finally {
      await this.redis.delIfEquals(lockKey, lockValue).catch(() => undefined);
    }
  }

  private async isStillCompany(userId: string, company: AccountRow): Promise<boolean> {
    const still = await this.accounts.getCompanyAccount(userId);
    return !!still && still.id === company.id;
  }

  private async run(userId: string, company: AccountRow, forceFull: boolean): Promise<SyncOutcome> {
    let full = forceFull || !company.fullResyncAt || this.now().getTime() - company.fullResyncAt.getTime() >= FULL_RESYNC_INTERVAL_MS;
    let cursor: string | null = full ? null : company.syncCursor;
    let generation = full ? company.syncGeneration + 1 : company.syncGeneration;
    let upserts = 0;
    let deletes = 0;
    let pages = 0;

    for (;;) {
      // The account may have been relabelled while the previous page was in flight: stop before another request.
      if (pages > 0 && !(await this.isStillCompany(userId, company))) return 'aborted_relabelled';
      let page: ChangesPage;
      try {
        page = await this.api.getChanges(userId, company.externalId, cursor);
      } catch (err) {
        if (err instanceof AiBudgetApiError && err.code === 'invalid_cursor' && !full) {
          full = true;
          cursor = null;
          generation = company.syncGeneration + 1;
          continue;
        }
        throw err;
      }
      const pageUpserts = page.changes.flatMap((c) => (c.type === 'upsert' ? [toMirrorInput(c.expense)] : []));
      const pageDeletes = page.changes.flatMap((c) => (c.type === 'delete' ? [c.id] : []));
      const applied = await this.repo.applyChangesPage(company.id, {
        upserts: pageUpserts, deletes: pageDeletes, nextCursor: page.next_cursor, generation,
      });
      if (applied === 'not_company') return 'aborted_relabelled';
      pages++;
      upserts += pageUpserts.length;
      deletes += pageDeletes.length;
      cursor = page.next_cursor;
      if (!page.has_more) break;
    }

    let swept = 0;
    if (full) {
      if (!(await this.isStillCompany(userId, company))) return 'aborted_relabelled';
      swept = await this.repo.sweepGeneration(company.id, generation);
      await this.repo.updateAccountSync(company.id, { fullResyncAt: this.now(), syncGeneration: generation });
    }
    await this.repo.updateAccountSync(company.id, { lastSyncedAt: this.now(), lastSyncError: null });
    await this.redis.del(`aib:recon:${userId}`).catch(() => undefined);
    logger.info('AI Budget mirror sync done', { userId, pages, upserts, deletes, swept, full });
    return 'synced';
  }
}
