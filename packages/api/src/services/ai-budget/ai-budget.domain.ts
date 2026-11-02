import type { CurrencyTotal } from './ai-budget.types';

/** Parses a decimal string ("42.50", "-1.5", "7") into integer cents without float drift. */
export function toCents(decimal: string): number {
  const m = /^(-)?(\d+)(?:\.(\d*))?$/.exec(decimal.trim());
  if (!m) throw new Error('Invalid decimal amount');
  const [, sign, whole, frac = ''] = m;
  const padded = (frac + '000').slice(0, 3);
  let cents = parseInt(whole, 10) * 100 + parseInt(padded.slice(0, 2), 10);
  if (parseInt(padded[2], 10) >= 5) cents += 1; // round half up on the third decimal
  return sign ? -cents : cents;
}

export function centsToNumber(cents: number): number {
  return Math.round(cents) / 100;
}

/** Debts and split receivables are money moving, not spending. */
export function isSpending(e: { isDebt: boolean; isSplitReceivable: boolean }): boolean {
  return !e.isDebt && !e.isSplitReceivable;
}

/** Splits decide when present (own category ignored); otherwise the own category takes the whole amount. */
export function attributeToCategories(e: {
  amountCents: number;
  categoryId: string | null;
  categorySplits: { categoryId: string | null; amountCents: number }[];
}): { categoryId: string | null; amountCents: number }[] {
  if (e.categorySplits.length > 0) {
    return e.categorySplits.map((s) => ({ categoryId: s.categoryId, amountCents: s.amountCents }));
  }
  return [{ categoryId: e.categoryId, amountCents: e.amountCents }];
}

/** Per-currency totals; currencies are never mixed. Sorted by upper-cased currency. */
export function sumByCurrency(items: { currency: string; amountCents: number }[]): CurrencyTotal[] {
  const byCurrency = new Map<string, number>();
  for (const it of items) {
    const c = it.currency.toUpperCase();
    byCurrency.set(c, (byCurrency.get(c) ?? 0) + it.amountCents);
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, cents]) => ({ currency, total: centsToNumber(cents) }));
}

const warsawFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Current calendar date in Europe/Warsaw as YYYY-MM-DD. */
export function warsawToday(now: Date): string {
  const parts = warsawFormat.formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Calendar month (Warsaw) `offsetMonths` back from now's month. */
export function warsawMonthWindow(
  now: Date,
  offsetMonths: 0 | -1 | -2 | -3 | -4 | -5,
): { from: string; to: string; month: string } {
  const [y, m] = warsawToday(now).split('-').map(Number);
  const idx = y * 12 + (m - 1) + offsetMonths;
  const year = Math.floor(idx / 12);
  const month = (idx % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`, month: `${year}-${mm}` };
}

/** Adds days to a YYYY-MM-DD string (calendar arithmetic, no timezone). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
