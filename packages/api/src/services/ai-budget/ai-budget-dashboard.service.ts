import type { RedisLike } from '../../lib/redis';
import { logger } from '../../utils/logger';
import type {
  AiBudgetCompanyDto, AiBudgetPersonalDto, CategoryCurrencyGroupDto,
} from '../../types/ai-budget-api.types';
import { attributeToCategories, centsToNumber, isSpending, sumByCurrency, toCents, warsawMonthWindow } from './ai-budget.domain';
import type { AiBudgetRepository } from './ai-budget.repository';
import type { RemoteCategory } from './ai-budget.types';
import type { AiBudgetAccountsService } from './ai-budget-accounts.service';
import type { AiBudgetLiveReadService } from './ai-budget-live.service';
import type { AiBudgetReconciliationService } from './ai-budget-reconciliation.service';
import type { AiBudgetMirrorSyncService } from './ai-budget-sync.service';

interface Row {
  currency: string;
  date: string;
  amountCents: number;
  categoryId: string | null;
  categorySplits: { categoryId: string; amountCents: number }[];
}

/** Category totals per currency, desc by total. Names come from `nameOf` (category ids are per account). */
function categoryGroups(rows: Row[], nameOf: (categoryId: string | null) => string | null): CategoryCurrencyGroupDto[] {
  const byCurrency = new Map<string, Map<string, { categoryId: string | null; categoryName: string | null; cents: number }>>();
  for (const r of rows) {
    const currency = r.currency.toUpperCase();
    const m = byCurrency.get(currency) ?? new Map();
    for (const part of attributeToCategories(r)) {
      const name = nameOf(part.categoryId);
      // Merge by name when known (the same category in two accounts has two ids); otherwise by id.
      const key = name !== null ? `n:${name.trim().toLowerCase()}` : `i:${part.categoryId ?? ''}`;
      const cur = m.get(key) ?? { categoryId: part.categoryId, categoryName: name, cents: 0 };
      cur.cents += part.amountCents;
      m.set(key, cur);
    }
    byCurrency.set(currency, m);
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, m]) => ({
      currency,
      items: [...m.values()]
        .sort((a, b) => b.cents - a.cents)
        .map((c) => ({ categoryId: c.categoryId, categoryName: c.categoryName, total: centsToNumber(c.cents) })),
    }));
}

const inMonth = (rows: Row[], w: { from: string; to: string }): Row[] => rows.filter((r) => r.date >= w.from && r.date <= w.to);
const totalsOf = (rows: Row[]) => sumByCurrency(rows.map((r) => ({ currency: r.currency, amountCents: r.amountCents })));

export interface AiBudgetDashboardDeps {
  repo: AiBudgetRepository;
  accounts: AiBudgetAccountsService;
  sync: Pick<AiBudgetMirrorSyncService, 'syncIfStale'>;
  live: Pick<AiBudgetLiveReadService, 'listExpenses' | 'listCategories'>;
  reconciliation: Pick<AiBudgetReconciliationService, 'getSummary'>;
  /** Only read, to tell whether a sync is running (`aib:sync:{row}`). */
  redis: RedisLike;
  now?: () => Date;
}

export class AiBudgetDashboardService {
  private readonly now: () => Date;

  constructor(private readonly deps: AiBudgetDashboardDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Connection gate: no figures for a missing, revoked or reconnect-needing connection. */
  private async gate(userId: string): Promise<{ ok: false; state: 'not_connected' | 'needs_reconnect' } | { ok: true; needsCompanyChoice: boolean }> {
    const conn = await this.deps.repo.getConnection(userId);
    if (!conn || conn.status === 'revoked') return { ok: false, state: 'not_connected' };
    if (conn.status === 'needs_reconnect') return { ok: false, state: 'needs_reconnect' };
    return { ok: true, needsCompanyChoice: conn.needsCompanyChoice };
  }

  async getCompany(userId: string): Promise<AiBudgetCompanyDto> {
    const { repo, accounts, sync, live, reconciliation, redis } = this.deps;
    const gate = await this.gate(userId);
    if (!gate.ok) return { state: gate.state };
    const all = await repo.listAccounts(userId);
    const labelled = all.find((a) => a.label === 'company');
    if (!labelled) return { state: 'no_company_account', needsCompanyChoice: gate.needsCompanyChoice };
    const company = labelled.active ? await accounts.getCompanyAccount(userId) : null;
    if (!company) return { state: 'company_inactive', accountName: labelled.name, reason: labelled.inactiveReason };

    // Fire and forget: answer from the mirror now; the next load sees the result.
    void sync.syncIfStale(userId).catch((err: unknown) => {
      logger.warn('AI Budget dashboard sync failed', { userId, error: (err as Error)?.name ?? 'unknown' });
    });

    const running = !!(await redis.get(`aib:sync:${company.id}`).catch(() => null));
    if (!company.lastSyncedAt) {
      return running || !company.lastSyncError ? { state: 'syncing' } : { state: 'sync_failed' };
    }

    const now = this.now();
    const cur = warsawMonthWindow(now, 0);
    const prev = warsawMonthWindow(now, -1);
    const mirror = await repo.listMirrorExpenses(company.id, prev.from, cur.to);
    const rows: Row[] = mirror.filter(isSpending).map((e) => ({
      currency: e.currency, date: e.date, amountCents: toCents(e.amount), categoryId: e.categoryId,
      categorySplits: e.categorySplits.map((s) => ({ categoryId: s.categoryId, amountCents: toCents(s.amount) })),
    }));
    const curRows = inMonth(rows, cur);
    const curTotals = new Map(totalsOf(curRows).map((t) => [t.currency, t.total]));
    const prevTotals = new Map(totalsOf(inMonth(rows, prev)).map((t) => [t.currency, t.total]));
    const currencies = [...new Set([...curTotals.keys(), ...prevTotals.keys()])].sort();
    const spending = currencies.map((currency) => ({ currency, current: curTotals.get(currency) ?? 0, previous: prevTotals.get(currency) ?? 0 }));

    let names = new Map<string, string | null>();
    try {
      const cats: RemoteCategory[] = await live.listCategories(userId, company);
      names = new Map(cats.map((c) => [c.id, c.name]));
    } catch {
      logger.warn('AI Budget dashboard categories unavailable', { userId });
    }
    const categories = categoryGroups(curRows, (id) => (id === null ? null : names.get(id) ?? null));

    return {
      state: 'ready',
      account: { name: company.name, currency: company.currency },
      sync: { state: running ? 'syncing' : company.lastSyncError ? 'failed' : 'ok', lastSyncedAt: company.lastSyncedAt.toISOString() },
      inactiveAccounts: all.filter((a) => !a.active).length,
      currentMonth: cur.month,
      spending,
      categories,
      reconciliation: await reconciliation.getSummary(userId),
    };
  }

  /** Private accounts only, read live; never other_business, never company. */
  async getPersonal(userId: string): Promise<AiBudgetPersonalDto> {
    const { repo, live } = this.deps;
    const gate = await this.gate(userId);
    if (!gate.ok) return { state: gate.state };
    const privates = (await repo.listAccounts(userId)).filter((a) => a.label === 'private');
    const active = privates.filter((a) => a.active);
    if (active.length === 0) return { state: 'no_private_accounts' };

    const now = this.now();
    const windows = ([-5, -4, -3, -2, -1, 0] as const).map((o) => warsawMonthWindow(now, o));
    const dateFrom = windows[0].from;
    const dateTo = windows[5].to;
    const cur = windows[5];

    const all: Row[] = [];
    const merged = new Map<string, CategoryCurrencyGroupDto>();
    let failed = 0;
    let truncated = false;
    for (const acc of active) {
      let res;
      try {
        res = await live.listExpenses(userId, acc, { dateFrom, dateTo });
      } catch (err) {
        failed++;
        logger.warn('AI Budget private account read failed', { userId, error: (err as Error)?.name ?? 'unknown' });
        continue;
      }
      truncated = truncated || res.truncated;
      const rows: Row[] = res.expenses
        .filter((e) => isSpending({ isDebt: e.is_debt, isSplitReceivable: e.is_split_receivable }))
        .map((e) => ({
          currency: e.currency, date: e.date, amountCents: toCents(e.amount), categoryId: e.category_id,
          categorySplits: e.category_splits.map((s) => ({ categoryId: s.category_id, amountCents: toCents(s.amount) })),
        }));
      all.push(...rows);

      let names = new Map<string, string | null>();
      try {
        names = new Map((await live.listCategories(userId, acc)).map((c) => [c.id, c.name]));
      } catch {
        logger.warn('AI Budget dashboard categories unavailable', { userId });
      }
      for (const g of categoryGroups(inMonth(rows, cur), (id) => (id === null ? null : names.get(id) ?? null))) {
        const into = merged.get(g.currency) ?? { currency: g.currency, items: [] };
        for (const it of g.items) {
          const same = into.items.find((x) =>
            it.categoryName !== null
              ? x.categoryName !== null && x.categoryName.trim().toLowerCase() === it.categoryName.trim().toLowerCase()
              : x.categoryName === null && x.categoryId === it.categoryId);
          if (same) same.total = centsToNumber(Math.round(same.total * 100) + Math.round(it.total * 100));
          else into.items.push({ ...it });
        }
        merged.set(g.currency, into);
      }
    }
    if (failed === active.length) return { state: 'error' };

    const trend = windows.map((w) => ({ month: w.month, totals: totalsOf(inMonth(all, w)) }));
    const categories = [...merged.values()]
      .sort((a, b) => (a.currency < b.currency ? -1 : 1))
      .map((g) => ({ currency: g.currency, items: g.items.sort((a, b) => b.total - a.total) }));

    return {
      state: 'ready',
      accounts: active.map((a) => ({ name: a.name, currency: a.currency })),
      inactiveAccounts: privates.length - active.length,
      failedAccounts: failed,
      truncated,
      thisMonth: trend[5].totals,
      trend,
      categories,
    };
  }
}
