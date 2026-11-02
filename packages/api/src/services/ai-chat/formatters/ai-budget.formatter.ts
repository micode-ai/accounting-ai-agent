/**
 * AI Budget Formatter
 * Every figure carries its label. Sections follow the order company, other business, private, and each
 * line starts with `**[<label>]**`. Totals are per label and per currency: nothing ever sums two labels
 * or two currencies. Debts and split receivables are not spending and never enter a total.
 */

import { getAiBudgetTranslations, Locale } from '../../../i18n';
import { attributeToCategories, isSpending } from '../../ai-budget/ai-budget.domain';
import type { AccountRow } from '../../ai-budget/ai-budget.repository';
import type { AiBudgetLabel } from '../../ai-budget/ai-budget.types';
import type { ExpenseQueryResult, ExpenseView } from '../../ai-budget/ai-budget-expenses.service';
import type { UnmatchedListResult } from '../../ai-budget/ai-budget-api.types';
import { sanitizeForPrompt } from '../utils';

export const AI_BUDGET_LABEL_ORDER: AiBudgetLabel[] = ['company', 'other_business', 'private'];

/** Category names per account external id, then per category id (null name: hidden by AI Budget). */
export type CategoryNames = Map<string, Map<string, string | null>>;

const intlLocale: Record<Locale, string> = { pl: 'pl-PL', en: 'en-GB', ru: 'ru-RU' };

export function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** Exact cents → "1234.50 PLN" (no float drift, no thousands separator). */
export function formatMoney(cents: number, currency: string): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')} ${currency.toUpperCase()}`;
}

export function labelTag(label: AiBudgetLabel, locale: Locale): string {
  return `**[${getAiBudgetTranslations(locale).label[label]}]**`;
}

/**
 * AI Budget text (merchant, description, account and category names) is written by third parties: co-members,
 * bank push notifications, receipts, imported statements. Before it reaches the model, everything that could
 * make the answer load a remote resource or carry an instruction-shaped payload is neutralized:
 * markdown images/links keep only their text, raw URLs keep only their host, data URIs, HTML tags, angle
 * brackets, backticks and stray link brackets are dropped. Then the usual prompt sanitizing and length cap apply.
 */
export function untrustedText(value: string | null, max: number): string | null {
  if (value === null) return null;
  const clean = value
    .slice(0, 2000)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // ![alt](url), [text](url) → text
    .replace(/<[^>]*>/g, ' ') // HTML tags
    .replace(/\bdata:\S+/gi, ' ') // data: URIs
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#]+)\S*/gi, '$1') // scheme://host/path?query → host
    .replace(/\b(www\.[^\s/?#]+)[/?#]\S*/gi, '$1') // www.host/path → www.host
    .replace(/[<>`[\]]/g, ''); // leftovers: angle brackets, backticks, link brackets
  const out = sanitizeForPrompt(clean.replace(/\s+/g, ' '), max).trim();
  return out || null;
}

export function accountName(name: string, locale: Locale): string {
  return (name && untrustedText(name, 100)) || getAiBudgetTranslations(locale).unknownAccount;
}

function text(value: string | null, max = 120): string | null {
  return untrustedText(value, max);
}

function formatTime(at: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale[locale], { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Warsaw' }).format(at);
}

function categoryLabel(names: CategoryNames, accountExternalId: string, categoryId: string | null, locale: Locale): string {
  const t = getAiBudgetTranslations(locale);
  if (categoryId === null) return t.uncategorized;
  const name = names.get(accountExternalId)?.get(categoryId);
  // A name AI Budget hides renders as the encrypted marker; an id whose name could not be loaded stays an id.
  return name === null ? t.encryptedField : name !== undefined ? untrustedText(name, 60) ?? t.uncategorized : `\`${categoryId}\``;
}

/** What a row adds to a total: the category share when a category filter was applied, else the full amount. */
const counted = (e: ExpenseView): { currency: string; amountCents: number } => ({ currency: e.currency, amountCents: e.matchedCents ?? e.amountCents });

function totalsByCurrency(rows: { currency: string; amountCents: number }[]): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.currency.toUpperCase(), (m.get(r.currency.toUpperCase()) ?? 0) + r.amountCents);
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function formatAiBudgetAccounts(accounts: AccountRow[], locale: Locale, opts: { sharedScope: boolean; needsCompanyChoice: boolean }): string {
  const t = getAiBudgetTranslations(locale);
  const out: string[] = ['## AI Budget'];
  if (opts.sharedScope) out.push(`> ${t.sharedOnlyCompany}`);
  if (!accounts.some((a) => a.label === 'company') || opts.needsCompanyChoice) out.push(`> ${t.noCompany}`);
  out.push('');
  for (const label of AI_BUDGET_LABEL_ORDER) {
    for (const a of accounts.filter((x) => x.label === label)) {
      const parts = [`${labelTag(label, locale)} ${accountName(a.name, locale)}`, `\`${a.externalId}\``];
      if (a.type) parts.push(a.type);
      if (a.currency) parts.push(a.currency);
      parts.push(t.access[a.access]);
      if (a.type === '') parts.push(t.unavailableShort);
      else if (!a.active) parts.push(t.inactiveShort);
      out.push(`- ${parts.join(' · ')}`);
    }
  }
  return out.join('\n');
}

export interface ExpensesListInput {
  result: ExpenseQueryResult;
  /** The accounts that were asked for (readable ones were queried; the rest are reported as unavailable). */
  accounts: AccountRow[];
  dateFrom: string;
  dateTo: string;
  limit: number;
  includeNonSpending: boolean;
  categoryNames: CategoryNames;
}

function expenseLine(e: ExpenseView, names: CategoryNames, locale: Locale): string {
  const t = getAiBudgetTranslations(locale);
  const amount = e.matchedCents !== undefined && e.matchedCents !== e.amountCents
    ? `${formatMoney(e.matchedCents, e.currency)} (${formatMoney(e.amountCents, e.currency)})`
    : formatMoney(e.amountCents, e.currency);
  const parts = [`${labelTag(e.label, locale)} ${e.date}`, amount, text(e.merchant, 80) ?? t.encryptedField];
  const description = text(e.description);
  if (description) parts.push(description);
  if (isSpending(e)) {
    const cats = attributeToCategories(e).map((c) => categoryLabel(names, e.accountExternalId, c.categoryId, locale));
    parts.push([...new Set(cats)].join(', '));
  } else {
    parts.push(e.isDebt ? t.nonSpending.debt : t.nonSpending.splitReceivable);
  }
  parts.push(`\`${e.id}\``);
  return `- ${parts.join(' · ')}`;
}

/** Notes shared by the list and the summary: company freshness, unread and inactive accounts, truncation. */
interface Status { notes: string[]; companyUnknown: boolean; companyUnknownText: string; partial: Set<AiBudgetLabel> }

function statusNotes(input: { result: ExpenseQueryResult; accounts: AccountRow[] }, locale: Locale): Status {
  const t = getAiBudgetTranslations(locale);
  const { result } = input;
  const notes: string[] = [];
  const companyAsked = input.accounts.some((a) => a.label === 'company' && a.active && a.type !== '');
  const companyUnknown = companyAsked && result.companyAsOf === null;
  if (companyAsked) {
    if (result.companyAsOf) notes.push(`> ${labelTag('company', locale)} ${fill(t.asOf, { time: formatTime(result.companyAsOf, locale) })}`);
    if (result.companyPending) notes.push(`> ${labelTag('company', locale)} ${t.syncing}`);
  }
  // A label with an account that was asked for but not read (failed or not readable) only has a partial total.
  const failedIds = new Set(result.failed.map((x) => x.accountExternalId));
  const partial = new Set(input.accounts.filter((a) => failedIds.has(a.externalId) || !a.active || a.type === '').map((a) => a.label));
  for (const a of input.accounts.filter((x) => !x.active || x.type === '')) {
    notes.push(`> ${labelTag(a.label, locale)} ${accountName(a.name, locale)}: ${t.inactive}`);
  }
  const byExt = new Map(input.accounts.map((a) => [a.externalId, a]));
  for (const f of result.failed) {
    const a = byExt.get(f.accountExternalId);
    if (a) notes.push(`> ${labelTag(a.label, locale)} ${fill(t.accountNotRead, { name: accountName(a.name, locale) })}`);
  }
  for (const ext of result.searchLimited) {
    const a = byExt.get(ext);
    if (a) notes.push(`> ${labelTag(a.label, locale)} ${fill(t.searchLimited, { name: accountName(a.name, locale) })}`);
  }
  if (result.truncated) notes.push(`> ${t.truncated}`);
  return { notes, companyUnknown, companyUnknownText: result.companySyncFailed ? t.syncFailed : t.syncing, partial };
}

const partialMark = (s: Status, label: AiBudgetLabel, t: { partial: string }): string => (s.partial.has(label) ? ` ${t.partial}` : '');

/** Labels that were actually read (so "no expenses" is a fact, not a guess). */
function readLabels(input: { result: ExpenseQueryResult; accounts: AccountRow[] }, companyUnknown: boolean): Set<AiBudgetLabel> {
  const failed = new Set(input.result.failed.map((f) => f.accountExternalId));
  const labels = new Set<AiBudgetLabel>();
  for (const a of input.accounts) {
    if (!a.active || a.type === '' || failed.has(a.externalId)) continue;
    if (a.label === 'company' && companyUnknown) continue;
    labels.add(a.label);
  }
  return labels;
}

export function formatAiBudgetExpenses(input: ExpensesListInput, locale: Locale): string {
  const t = getAiBudgetTranslations(locale);
  const { result } = input;
  const status = statusNotes(input, locale);
  const { notes, companyUnknown } = status;
  const read = readLabels(input, companyUnknown);
  const spending = result.expenses.filter(isSpending);
  const out: string[] = [`## AI Budget · ${input.dateFrom} – ${input.dateTo}`, ...notes, '', `### ${t.totalsHeader}`];

  for (const label of AI_BUDGET_LABEL_ORDER) {
    if (label === 'company' && companyUnknown) {
      out.push(`${labelTag(label, locale)} ${status.companyUnknownText}`);
      continue;
    }
    if (!read.has(label)) continue;
    const mark = partialMark(status, label, t);
    const totals = totalsByCurrency(spending.filter((e) => e.label === label).map(counted));
    if (totals.length === 0) out.push(`${labelTag(label, locale)} ${t.noExpenses}${mark}`);
    for (const [currency, cents] of totals) out.push(`${labelTag(label, locale)} ${formatMoney(cents, currency)}${mark}`);
  }

  const listed = (input.includeNonSpending ? result.expenses : spending).slice(0, input.limit);
  const shownSpending = listed.filter(isSpending);
  for (const label of AI_BUDGET_LABEL_ORDER) {
    const rows = shownSpending.filter((e) => e.label === label);
    const accounts = [...new Map(rows.map((r) => [r.accountExternalId, r.accountName])).entries()];
    for (const [ext, name] of accounts) {
      out.push('', `#### ${labelTag(label, locale)} ${accountName(name, locale)} · \`${ext}\``);
      for (const e of rows.filter((r) => r.accountExternalId === ext)) out.push(expenseLine(e, input.categoryNames, locale));
    }
  }
  const nonSpending = listed.filter((e) => !isSpending(e));
  if (input.includeNonSpending && nonSpending.length > 0) {
    out.push('', `### ${t.nonSpendingHeader}`);
    for (const label of AI_BUDGET_LABEL_ORDER) {
      for (const e of nonSpending.filter((r) => r.label === label)) {
        out.push(`${expenseLine(e, input.categoryNames, locale)} · ${accountName(e.accountName, locale)} \`${e.accountExternalId}\``);
      }
    }
  }
  const total = input.includeNonSpending ? result.expenses.length : spending.length;
  if (listed.length < total) out.push('', fill(t.showing, { shown: listed.length, total }));
  return out.join('\n');
}

export interface SummaryInput {
  result: ExpenseQueryResult;
  accounts: AccountRow[];
  dateFrom: string;
  dateTo: string;
  groupBy: 'category' | 'month';
  categoryNames: CategoryNames;
}

export function formatAiBudgetSummary(input: SummaryInput, locale: Locale): string {
  const t = getAiBudgetTranslations(locale);
  const status = statusNotes(input, locale);
  const { notes, companyUnknown } = status;
  const read = readLabels(input, companyUnknown);
  const spending = input.result.expenses.filter(isSpending);
  const out: string[] = [`## AI Budget · ${input.dateFrom} – ${input.dateTo}`, ...notes];

  for (const label of AI_BUDGET_LABEL_ORDER) {
    if (label === 'company' && companyUnknown) {
      out.push('', `${labelTag(label, locale)} ${status.companyUnknownText}`);
      continue;
    }
    if (!read.has(label)) continue;
    const mark = partialMark(status, label, t);
    const rows = spending.filter((e) => e.label === label);
    out.push('', `### ${labelTag(label, locale)}`);
    if (rows.length === 0) {
      out.push(`${labelTag(label, locale)} ${t.noExpenses}${mark}`);
      continue;
    }
    // key → currency → cents; categories merge by name across this label's accounts (ids are per account).
    const groups = new Map<string, { title: string; byCurrency: Map<string, number> }>();
    for (const e of rows) {
      const parts = input.groupBy === 'month'
        ? [{ key: e.date.slice(0, 7), title: e.date.slice(0, 7), amountCents: counted(e).amountCents }]
        : attributeToCategories(e).map((c) => {
          const title = categoryLabel(input.categoryNames, e.accountExternalId, c.categoryId, locale);
          return { key: title.trim().toLowerCase(), title, amountCents: c.amountCents };
        });
      for (const p of parts) {
        const g = groups.get(p.key) ?? { title: p.title, byCurrency: new Map<string, number>() };
        const cur = e.currency.toUpperCase();
        g.byCurrency.set(cur, (g.byCurrency.get(cur) ?? 0) + p.amountCents);
        groups.set(p.key, g);
      }
    }
    const ordered = [...groups.entries()].sort(([ka, a], [kb, b]) => {
      if (input.groupBy === 'month') return ka < kb ? -1 : 1;
      const sum = (g: typeof a): number => [...g.byCurrency.values()].reduce((s, v) => s + v, 0);
      return sum(b) - sum(a) || (ka < kb ? -1 : 1);
    });
    for (const [, g] of ordered) {
      for (const [currency, cents] of [...g.byCurrency.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        out.push(`${labelTag(label, locale)} ${g.title}: ${formatMoney(cents, currency)}${mark}`);
      }
    }
    out.push(`**${t.totalsHeader}:**`);
    for (const [currency, cents] of totalsByCurrency(rows.map(counted))) out.push(`${labelTag(label, locale)} ${formatMoney(cents, currency)}${mark}`);
  }
  return out.join('\n');
}

export function formatAiBudgetWrite(kind: 'created' | 'updated', e: ExpenseView, locale: Locale): string {
  const t = getAiBudgetTranslations(locale);
  const parts = [
    `${labelTag(e.label, locale)} ${accountName(e.accountName, locale)} \`${e.accountExternalId}\``,
    e.date,
    formatMoney(e.amountCents, e.currency),
    text(e.merchant, 80) ?? t.encryptedField,
  ];
  const description = text(e.description);
  if (description) parts.push(description);
  parts.push(`\`${e.id}\``);
  return fill(t[kind], { summary: parts.join(' · ') });
}

export function formatAiBudgetDeleted(account: AccountRow, expenseId: string, locale: Locale): string {
  const t = getAiBudgetTranslations(locale);
  return fill(t.deleted, { summary: `${labelTag(account.label, locale)} ${accountName(account.name, locale)} \`${account.externalId}\` · \`${expenseId}\`` });
}

export function formatAiBudgetUnmatched(r: UnmatchedListResult, asOf: Date | null, locale: Locale): string {
  const t = getAiBudgetTranslations(locale);
  if (r.state !== 'ok') {
    return r.state === 'no_company' ? t.noCompany : r.state === 'wfirma_not_connected' ? t.wfirmaNeeded : t.wfirmaError;
  }
  const out: string[] = [`## ${labelTag('company', locale)} ${t.noMatchingDocument}`];
  if (asOf) out.push(`> ${fill(t.asOf, { time: formatTime(asOf, locale) })}`);
  if (r.truncated) out.push(`> ${t.truncated}`);
  out.push('');
  if (r.items.length === 0) {
    out.push(`${labelTag('company', locale)} ${t.allMatched}`);
    return out.join('\n');
  }
  for (const i of r.items) {
    out.push(`- ${labelTag('company', locale)} ${i.date} · ${formatMoney(Math.round(i.amount * 100), i.currency)} · ${text(i.merchant, 80) ?? t.encryptedField} · \`${i.expenseId}\``);
  }
  for (const [currency, cents] of totalsByCurrency(r.items.map((i) => ({ currency: i.currency, amountCents: Math.round(i.amount * 100) })))) {
    out.push(`${labelTag('company', locale)} **${t.totalsHeader}:** ${formatMoney(cents, currency)}`);
  }
  return out.join('\n');
}
