import type { RedisLike } from '../../lib/redis';
import { logger } from '../../utils/logger';
import type { WFirmaServiceFactory } from '../wfirma-integration.factory';
import { addDays, centsToNumber, isSpending, sumByCurrency, toCents, warsawMonthWindow, warsawToday } from './ai-budget.domain';
import type { AiBudgetRepository } from './ai-budget.repository';
import type { ReconciliationDto, UnmatchedItemDto, UnmatchedListResult } from './ai-budget-api.types';
import type { AiBudgetAccountsService } from './ai-budget-accounts.service';
import { DATE_TOLERANCE_DAYS, matchExpensesToDocuments, type ReconDocument, type ReconExpense } from './reconcile';

export const RECON_CACHE_TTL_SECONDS = 300;
export const RECON_TOP_ITEMS = 5;
const WFIRMA_LIMIT = 1000;
const cacheKey = (userId: string): string => `aib:recon:${userId}`;

type Computed =
  | { state: 'wfirma_not_connected' | 'wfirma_error' | 'no_company' }
  | { state: 'ok'; companyId: string; window: { from: string; to: string }; items: UnmatchedItemDto[]; dismissedCount: number; truncated: boolean };

const byAmountDesc = (a: UnmatchedItemDto, b: UnmatchedItemDto): number =>
  b.amount - a.amount || (a.expenseId < b.expenseId ? -1 : 1);

/**
 * Company expenses with no matching wFirma cost document. wFirma reads here are deliberately not
 * metered (no checkWFirmaLimit / incrementWFirmaUsage). The caller has established a ready company account.
 */
export class AiBudgetReconciliationService {
  constructor(
    private readonly repo: AiBudgetRepository,
    private readonly accounts: AiBudgetAccountsService,
    private readonly wfirma: WFirmaServiceFactory,
    private readonly redis: RedisLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getSummary(userId: string): Promise<ReconciliationDto> {
    const company = await this.accounts.getCompanyAccount(userId);
    if (!company) return { state: 'no_company' };
    const cached = await this.redis.get(cacheKey(userId)).catch(() => null);
    if (cached) {
      try {
        // The payload carries the company row it was built for: a company change must not serve the old one.
        const hit = JSON.parse(cached) as { companyId: string; dto: ReconciliationDto };
        if (hit.companyId === company.id) return hit.dto;
      } catch {
        // unreadable cache entry: recompute
      }
    }
    const r = await this.compute(userId);
    if (r.state !== 'ok') return { state: r.state };
    const dto: ReconciliationDto = {
      state: 'ok',
      window: r.window,
      unmatchedCount: r.items.length,
      unmatchedTotals: sumByCurrency(r.items.map((i) => ({ currency: i.currency, amountCents: Math.round(i.amount * 100) }))),
      items: [...r.items].sort(byAmountDesc).slice(0, RECON_TOP_ITEMS),
      dismissedCount: r.dismissedCount,
      ...(r.truncated ? { truncated: true } : {}),
    };
    await this.redis.setEx(cacheKey(userId), RECON_CACHE_TTL_SECONDS, JSON.stringify({ companyId: r.companyId, dto })).catch(() => undefined);
    return dto;
  }

  /** Drops the cached dashboard summary (after a company write from chat). Never throws. */
  async invalidate(userId: string): Promise<void> {
    await this.redis.del(cacheKey(userId)).catch(() => undefined);
  }

  /** Full list (amount desc), for the chat tool. */
  async listUnmatched(userId: string): Promise<UnmatchedListResult> {
    const r = await this.compute(userId);
    if (r.state !== 'ok') return { state: r.state };
    return { state: 'ok', items: [...r.items].sort(byAmountDesc), truncated: r.truncated };
  }

  async dismiss(userId: string, externalExpenseId: string, reason: string | null): Promise<'dismissed' | 'no_company' | 'not_found'> {
    const company = await this.accounts.getCompanyAccount(userId);
    if (!company) return 'no_company';
    if (!(await this.repo.findMirrorExpense(company.id, externalExpenseId))) return 'not_found';
    await this.repo.addDismissal(company.id, externalExpenseId, reason);
    await this.redis.del(cacheKey(userId)).catch(() => undefined);
    return 'dismissed';
  }

  private async compute(userId: string): Promise<Computed> {
    const company = await this.accounts.getCompanyAccount(userId);
    if (!company) return { state: 'no_company' };
    if (!(await this.wfirma.hasUserCredentials(userId))) return { state: 'wfirma_not_connected' };

    const today = warsawToday(this.now());
    const from = warsawMonthWindow(this.now(), -1).from;
    const rows = await this.repo.listMirrorExpenses(company.id, from, today);
    const dismissed = await this.repo.listDismissedIds(company.id);
    const spending = rows.filter(isSpending);
    const dismissedCount = spending.filter((r) => dismissed.has(r.externalId)).length;
    const live = spending.filter((r) => !dismissed.has(r.externalId));

    let docs: ReconDocument[];
    let truncated = false;
    try {
      const service = await this.wfirma.getServiceForUser(userId);
      const found = await service.findExpenses({
        dateFrom: new Date(addDays(from, -DATE_TOLERANCE_DAYS)),
        dateTo: new Date(addDays(today, DATE_TOLERANCE_DAYS)),
        limit: WFIRMA_LIMIT,
      });
      truncated = found.length >= WFIRMA_LIMIT;
      docs = found.map((x) => ({
        id: x.id,
        date: warsawToday(new Date(x.date)),
        grossCents: Math.round(x.total * 100),
        currency: x.currency,
        contractorName: x.contractorName ?? null,
      }));
    } catch (err) {
      logger.warn('AI Budget reconciliation: wFirma read failed', { userId, error: (err as Error)?.name ?? 'unknown' });
      return { state: 'wfirma_error' };
    }

    const expenses: ReconExpense[] = live.map((r) => ({
      id: r.externalId, date: r.date, amountCents: toCents(r.amount), currency: r.currency, text: r.merchant ?? r.description,
    }));
    const { unmatched } = matchExpensesToDocuments(expenses, docs);
    const byId = new Map(live.map((r) => [r.externalId, r]));
    const items = unmatched.map((e) => ({
      expenseId: e.id,
      date: e.date,
      amount: centsToNumber(e.amountCents),
      currency: e.currency.toUpperCase(),
      merchant: byId.get(e.id)?.merchant ?? null,
    }));
    return { state: 'ok', companyId: company.id, window: { from, to: today }, items, dismissedCount, truncated };
  }
}
