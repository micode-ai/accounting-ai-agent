/**
 * AI Budget Tools
 * The optional chat tool group for a user with an AI Budget connection. Every figure is labelled company,
 * other business or private; in a conversation shared with the organization (`company_only`) only the
 * company account is reachable and every other account is refused as if it did not exist. Errors come back
 * as localized markdown and never throw into the graph. Nothing from an expense payload is logged here.
 */

import { tool, StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { logger } from '../../../utils/logger';
import { getAiBudgetTranslations, Locale, type AiBudgetTranslations } from '../../../i18n';
import { warsawMonthWindow } from '../../ai-budget/ai-budget.domain';
import type { AccountRow, AiBudgetRepository } from '../../ai-budget/ai-budget.repository';
import type { AiBudgetLabel } from '../../ai-budget/ai-budget.types';
import type { AiBudgetAccountsService } from '../../ai-budget/ai-budget-accounts.service';
import { AiBudgetApiError, AiBudgetNotConnectedError, AiBudgetReconnectRequiredError } from '../../ai-budget/ai-budget-errors';
import {
  AiBudgetWriteRefused, type AiBudgetExpensesService, type ExpensePatch,
} from '../../ai-budget/ai-budget-expenses.service';
import type { AiBudgetReconciliationService } from '../../ai-budget/ai-budget-reconciliation.service';
import {
  fill, untrustedText, formatAiBudgetAccounts, formatAiBudgetDeleted, formatAiBudgetExpenses, formatAiBudgetSummary, formatAiBudgetUnmatched,
  formatAiBudgetWrite, type CategoryNames,
} from '../formatters/ai-budget.formatter';

export const AI_BUDGET_TOOL_PREFIX = 'ai_budget_';

export function isAiBudgetTool(name: string): boolean {
  return name.startsWith(AI_BUDGET_TOOL_PREFIX);
}

export type AiBudgetToolScope = 'all' | 'company_only';

export interface AiBudgetToolContext {
  userId: string;
  locale: Locale;
  scope: AiBudgetToolScope;
  connectionStatus: 'active' | 'needs_reconnect';
  expenses: AiBudgetExpensesService;
  accounts: AiBudgetAccountsService;
  reconciliation: AiBudgetReconciliationService;
  repo: AiBudgetRepository;
  /** Called whenever a tool puts private or other-business data into the conversation. */
  onNonCompanyData: () => void;
  now?: () => Date;
}

const AMOUNT = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Decimal string, at most 2 decimal places, e.g. "42.50"');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const CURRENCY = z.string().regex(/^[A-Za-z]{3}$/, 'ISO 4217 code, e.g. PLN');
const LABEL = z.enum(['company', 'other_business', 'private']);
const ACCOUNT_ID = z.string().min(1).describe('AI Budget account id, exactly as shown by ai_budget_list_accounts');

const readable = (a: AccountRow): boolean => a.active && a.type !== '';

type Resolved = { ok: true; row: AccountRow } | { ok: false; message: string };

/** Shared plumbing: connection gate, scope-aware account resolution, error → localized text. */
class Toolkit {
  readonly t: AiBudgetTranslations;

  constructor(readonly ctx: AiBudgetToolContext) {
    this.t = getAiBudgetTranslations(ctx.locale);
  }

  /** Accounts this conversation may see. */
  async visible(): Promise<{ all: AccountRow[]; visible: AccountRow[] }> {
    const all = await this.ctx.repo.listAccounts(this.ctx.userId);
    return { all, visible: this.ctx.scope === 'company_only' ? all.filter((a) => a.label === 'company') : all };
  }

  async resolve(externalId: string, opts: { needReadable: boolean }): Promise<Resolved> {
    const { all, visible } = await this.visible();
    const row = visible.find((a) => a.externalId === externalId);
    if (!row) {
      // In a shared chat an account outside the scope is refused the same way, without revealing anything about it.
      const hidden = this.ctx.scope === 'company_only' && all.some((a) => a.externalId === externalId);
      return { ok: false, message: hidden || this.ctx.scope === 'company_only' ? this.t.sharedOnlyCompany : this.t.unknownAccount };
    }
    if (opts.needReadable && !readable(row)) return { ok: false, message: this.t.inactive };
    return { ok: true, row };
  }

  /** Called before any non-company account is read or written, so a failed read still counts. */
  touch(rows: AccountRow[]): void {
    if (rows.some((a) => a.label !== 'company')) this.ctx.onNonCompanyData();
  }

  async categoryNames(rows: AccountRow[]): Promise<CategoryNames> {
    const names: CategoryNames = new Map();
    for (const a of rows) {
      try {
        const cats = await this.ctx.expenses.listCategories(this.ctx.userId, a);
        names.set(a.externalId, new Map(cats.map((c) => [c.id, c.name])));
      } catch {
        logger.warn('AI Budget chat categories unavailable', { userId: this.ctx.userId });
      }
    }
    return names;
  }

  errorMessage(err: unknown, extra: { categoryName?: string } = {}): string {
    const t = this.t;
    if (err instanceof AiBudgetWriteRefused) {
      if (err.reason === 'read_only') return t.readOnly;
      if (err.reason === 'inactive') return t.inactive;
      if (err.reason === 'unknown_category') {
        // Category names come from AI Budget (third-party text) and the name from the model: both sanitized.
        return fill(t.unknownCategory, {
          name: untrustedText(extra.categoryName ?? '', 60) ?? '',
          list: err.available.map((n) => untrustedText(n, 60)).filter(Boolean).join(', ') || '—',
        });
      }
      return this.ctx.scope === 'company_only' ? t.sharedOnlyCompany : t.unknownAccount;
    }
    if (err instanceof AiBudgetReconnectRequiredError) return t.reconnect;
    if (err instanceof AiBudgetNotConnectedError) return t.notConnected;
    if (err instanceof AiBudgetApiError) {
      if (err.status === 403 && err.code === 'account_encrypted') return t.encryptedWrite;
      if (err.status === 404) return t.expenseNotFound;
      return fill(t.requestFailed, { code: err.code });
    }
    return fill(t.requestFailed, { code: 'unknown' });
  }

  /** Wraps a tool body: reconnect gate first, every failure becomes localized text. */
  guard<A>(name: string, body: (args: A) => Promise<string>, extra?: (args: A) => { categoryName?: string }) {
    return async (args: A): Promise<string> => {
      if (this.ctx.connectionStatus === 'needs_reconnect') return this.t.reconnect;
      try {
        return await body(args);
      } catch (err) {
        const code = err instanceof AiBudgetApiError ? err.code : err instanceof AiBudgetWriteRefused ? err.reason : (err as Error)?.name ?? 'unknown';
        logger.warn('AI Budget chat tool failed', { userId: this.ctx.userId, tool: name, code });
        return this.errorMessage(err, extra ? extra(args) : {});
      }
    };
  }

  /** Accounts for a read: one account by id, or the visible ones filtered by label. A string is a refusal. */
  async readSet(args: { label?: AiBudgetLabel | null; accountId?: string | null }): Promise<AccountRow[] | string> {
    if (args.accountId) {
      const r = await this.resolve(args.accountId, { needReadable: true });
      return r.ok ? [r.row] : r.message;
    }
    if (this.ctx.scope === 'company_only' && args.label && args.label !== 'company') return this.t.sharedOnlyCompany;
    const { visible } = await this.visible();
    const rows = args.label ? visible.filter((a) => a.label === args.label) : visible;
    if (rows.length === 0) {
      if (args.label === 'company' || this.ctx.scope === 'company_only') return this.t.noCompany;
      return args.label ? fill(this.t.noAccountForLabel, { label: this.t.label[args.label] }) : this.t.noAccounts;
    }
    return rows;
  }

  writeOptions(): { companyOnly: boolean } {
    return { companyOnly: this.ctx.scope === 'company_only' };
  }
}

const strip = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;

export function createAiBudgetTools(ctx: AiBudgetToolContext): StructuredToolInterface[] {
  const k = new Toolkit(ctx);
  const now = ctx.now ?? (() => new Date());
  const mk = tool as unknown as (fn: (args: never) => Promise<string>, cfg: { name: string; description: string; schema: z.ZodTypeAny }) => StructuredToolInterface;

  const listAccounts = mk(
    k.guard('ai_budget_list_accounts', async () => {
      const { visible } = await k.visible();
      k.touch(visible);
      const conn = await ctx.repo.getConnection(ctx.userId);
      return formatAiBudgetAccounts(visible, ctx.locale, { sharedScope: ctx.scope === 'company_only', needsCompanyChoice: !!conn?.needsCompanyChoice });
    }),
    {
      name: 'ai_budget_list_accounts',
      description: 'List the connected AI Budget accounts with their id, label (company / other business / private), currency and access (read-only or read and write). Call this first to get an accountId for any other AI Budget tool.',
      schema: z.object({}),
    },
  );

  const getExpenses = mk(
    k.guard('ai_budget_get_expenses', async (args: {
      label?: AiBudgetLabel | null; accountId?: string | null; dateFrom?: string | null; dateTo?: string | null; categoryName?: string | null;
      text?: string | null; includeNonSpending?: boolean | null; limit?: number | null;
    }) => {
      const set = await k.readSet(args);
      if (typeof set === 'string') return set;
      const month = warsawMonthWindow(now(), 0);
      const dateFrom = args.dateFrom ?? month.from;
      const dateTo = args.dateTo ?? month.to;
      k.touch(set.filter(readable));
      const result = await ctx.expenses.query(ctx.userId, {
        accounts: set, dateFrom, dateTo, ...(args.categoryName ? { categoryName: args.categoryName } : {}), ...(args.text ? { text: args.text } : {}),
      });
      if (result.unknownCategory) {
        return fill(k.t.unknownCategory, { name: untrustedText(args.categoryName ?? '', 60) ?? '', list: result.unknownCategory.map((n) => untrustedText(n, 60)).filter(Boolean).join(', ') || '—' });
      }
      const withRows = set.filter((a) => result.expenses.some((e) => e.accountExternalId === a.externalId));
      return formatAiBudgetExpenses({
        result, accounts: set, dateFrom, dateTo, limit: args.limit ?? 20, includeNonSpending: !!args.includeNonSpending,
        categoryNames: await k.categoryNames(withRows),
      }, ctx.locale);
    }),
    {
      name: 'ai_budget_get_expenses',
      description: 'List AI Budget expenses with totals per label and per currency. Filter by label, accountId, period (defaults to the current month), category name or text. Debts and bill shares owed back are not spending: they are left out of totals and listed only with includeNonSpending. These are AI Budget expenses, not wFirma documents.',
      schema: z.object({
        label: LABEL.nullable().optional().describe('Only accounts with this label'),
        accountId: ACCOUNT_ID.nullable().optional(),
        dateFrom: DATE.nullable().optional().describe('Start date YYYY-MM-DD inclusive; pass it whenever the user names a period'),
        dateTo: DATE.nullable().optional().describe('End date YYYY-MM-DD inclusive'),
        categoryName: z.string().max(100).nullable().optional().describe('Category name as the user says it (case-insensitive); an unknown name returns the available names'),
        text: z.string().max(100).nullable().optional().describe('Text to find in merchant or description'),
        includeNonSpending: z.boolean().nullable().optional().describe('Also list debts and bill shares owed back (never counted in totals)'),
        limit: z.number().int().min(1).max(50).nullable().optional().describe('How many expenses to list (1-50, default 20); totals cover all'),
      }),
    },
  );

  const spendingSummary = mk(
    k.guard('ai_budget_spending_summary', async (args: {
      label?: AiBudgetLabel | null; accountId?: string | null; dateFrom: string; dateTo: string; groupBy: 'category' | 'month';
    }) => {
      const set = await k.readSet(args);
      if (typeof set === 'string') return set;
      k.touch(set.filter(readable));
      const result = await ctx.expenses.query(ctx.userId, { accounts: set, dateFrom: args.dateFrom, dateTo: args.dateTo });
      const withRows = set.filter((a) => result.expenses.some((e) => e.accountExternalId === a.externalId));
      return formatAiBudgetSummary({
        result, accounts: set, dateFrom: args.dateFrom, dateTo: args.dateTo, groupBy: args.groupBy,
        categoryNames: args.groupBy === 'category' ? await k.categoryNames(withRows) : new Map(),
      }, ctx.locale);
    }),
    {
      name: 'ai_budget_spending_summary',
      description: 'AI Budget spending totals by category or by month, per label and per currency. Debts and bill shares owed back are excluded. Category splits decide the category when present.',
      schema: z.object({
        label: LABEL.nullable().optional(),
        accountId: ACCOUNT_ID.nullable().optional(),
        dateFrom: DATE.describe('Start date YYYY-MM-DD inclusive'),
        dateTo: DATE.describe('End date YYYY-MM-DD inclusive'),
        groupBy: z.enum(['category', 'month']),
      }),
    },
  );

  const createExpense = mk(
    k.guard('ai_budget_create_expense', async (args: {
      accountId: string; amount: string; date: string; currency?: string | null; categoryName?: string | null; merchant?: string | null; description?: string | null;
    }) => {
      const r = await k.resolve(args.accountId, { needReadable: true });
      if (!r.ok) return r.message;
      if (r.row.access !== 'read_write') return k.t.readOnly;
      k.touch([r.row]);
      const input = strip({
        amount: args.amount, date: args.date, currency: args.currency, categoryName: args.categoryName, merchant: args.merchant, description: args.description,
      }) as { amount: string; date: string; currency?: string; categoryName?: string; merchant?: string; description?: string };
      if (input.currency) input.currency = input.currency.toUpperCase();
      const created = await ctx.expenses.create(ctx.userId, r.row.id, input, k.writeOptions());
      return formatAiBudgetWrite('created', created, ctx.locale);
    }, (a) => ({ categoryName: a.categoryName ?? undefined })),
    {
      name: 'ai_budget_create_expense',
      description: 'Create an expense in one AI Budget account. Requires an explicit accountId. Before calling, state the amount, date and target account with its label to the user and get confirmation.',
      schema: z.object({
        accountId: ACCOUNT_ID,
        amount: AMOUNT.describe('Amount as a decimal string, at most 2 decimals, e.g. "42.50"'),
        date: DATE.describe('Expense date YYYY-MM-DD'),
        currency: CURRENCY.nullable().optional().describe('Defaults to the account currency'),
        categoryName: z.string().max(100).nullable().optional().describe('Category name as it exists in that account'),
        merchant: z.string().max(200).nullable().optional(),
        description: z.string().max(500).nullable().optional(),
      }),
    },
  );

  const updateExpense = mk(
    k.guard('ai_budget_update_expense', async (args: {
      accountId: string; expenseId: string; amount?: string | null; date?: string | null; currency?: string | null;
      categoryName?: string | null; merchant?: string | null; description?: string | null;
    }) => {
      const r = await k.resolve(args.accountId, { needReadable: true });
      if (!r.ok) return r.message;
      if (r.row.access !== 'read_write') return k.t.readOnly;
      // amount/date/currency: null means "not given"; categoryName/merchant/description: null clears the field.
      const patch: ExpensePatch = {};
      if (args.amount != null) patch.amount = args.amount;
      if (args.date != null) patch.date = args.date;
      if (args.currency != null) patch.currency = args.currency.toUpperCase();
      if (args.categoryName !== undefined) patch.categoryName = args.categoryName;
      if (args.merchant !== undefined) patch.merchant = args.merchant;
      if (args.description !== undefined) patch.description = args.description;
      if (Object.keys(patch).length === 0) return k.t.nothingToUpdate;
      k.touch([r.row]);
      const updated = await ctx.expenses.update(ctx.userId, r.row.id, args.expenseId, patch, k.writeOptions());
      return formatAiBudgetWrite('updated', updated, ctx.locale);
    }, (a) => ({ categoryName: a.categoryName ?? undefined })),
    {
      name: 'ai_budget_update_expense',
      description: 'Change an expense in one AI Budget account. Requires accountId and expenseId. Pass only the fields to change; null for categoryName, merchant or description clears it. Confirm the change, the account and its label with the user first.',
      schema: z.object({
        accountId: ACCOUNT_ID,
        expenseId: z.string().min(1),
        amount: AMOUNT.nullable().optional(),
        date: DATE.nullable().optional(),
        currency: CURRENCY.nullable().optional(),
        categoryName: z.string().max(100).nullable().optional(),
        merchant: z.string().max(200).nullable().optional(),
        description: z.string().max(500).nullable().optional(),
      }),
    },
  );

  const deleteExpense = mk(
    k.guard('ai_budget_delete_expense', async (args: { accountId: string; expenseId: string }) => {
      const r = await k.resolve(args.accountId, { needReadable: true });
      if (!r.ok) return r.message;
      if (r.row.access !== 'read_write') return k.t.readOnly;
      k.touch([r.row]);
      await ctx.expenses.remove(ctx.userId, r.row.id, args.expenseId, k.writeOptions());
      return formatAiBudgetDeleted(r.row, args.expenseId, ctx.locale);
    }),
    {
      name: 'ai_budget_delete_expense',
      description: 'Delete an expense from one AI Budget account. Requires accountId and expenseId. Warn that it cannot be undone and confirm the account and its label first.',
      schema: z.object({ accountId: ACCOUNT_ID, expenseId: z.string().min(1) }),
    },
  );

  const withoutDocument = mk(
    k.guard('ai_budget_expenses_without_document', async () => {
      const labelled = (await ctx.repo.listAccounts(ctx.userId)).find((a) => a.label === 'company');
      if (!labelled) return k.t.noCompany;
      if (!readable(labelled)) return k.t.inactive;
      const { company, pending, syncFailed } = await ctx.expenses.ensureCompanyFresh(ctx.userId);
      if (!company) return k.t.noCompany;
      // An empty mirror before the first sync would read as "all matched": report syncing / failed instead.
      if (!company.lastSyncedAt) return syncFailed ? k.t.syncFailed : k.t.syncing;
      const r = await ctx.reconciliation.listUnmatched(ctx.userId);
      const out = formatAiBudgetUnmatched(r, company.lastSyncedAt, ctx.locale);
      return pending && r.state === 'ok' ? `${out}\n\n> ${k.t.syncing}` : out;
    }),
    {
      name: 'ai_budget_expenses_without_document',
      description: 'Company AI Budget expenses (previous month to today) for which no matching cost document was found in wFirma. Company account only.',
      schema: z.object({}),
    },
  );

  return [listAccounts, getExpenses, spendingSummary, createExpense, updateExpense, deleteExpense, withoutDocument];
}
