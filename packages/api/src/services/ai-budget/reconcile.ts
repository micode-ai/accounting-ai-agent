// Pure matching of AI Budget company expenses against wFirma cost documents.

export const DATE_TOLERANCE_DAYS = 7;
export const AMOUNT_TOLERANCE_CENTS = 1;

/** text = merchant ?? description */
export interface ReconExpense { id: string; date: string; amountCents: number; currency: string; text: string | null }
export interface ReconDocument { id: string; date: string; grossCents: number; currency: string; contractorName: string | null }

const DROP_TOKENS = new Set(['sp', 'z', 'o', 'oo', 'sa', 'spk', 'sj', 'spolka', 'ltd', 'gmbh']);

/** Lowercase, diacritics and punctuation stripped, legal-form tokens dropped. */
export function normalizeName(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 0 && !DROP_TOKENS.has(t));
}

/** Token Jaccard 0..1; null or empty gives 0. */
export function nameSimilarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const ta = new Set(normalizeName(a));
  const tb = new Set(normalizeName(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function daysBetween(a: string, b: string): number {
  const ms = (s: string): number => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round(Math.abs(ms(a) - ms(b)) / 86400_000);
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One-to-one: scarcest expenses first, each takes the most similar (then closest, then lowest id) free document. */
export function matchExpensesToDocuments(
  expenses: ReconExpense[],
  docs: ReconDocument[],
): { matched: { expenseId: string; documentId: string }[]; unmatched: ReconExpense[] } {
  const candidates = (e: ReconExpense): ReconDocument[] =>
    docs.filter(
      (d) =>
        d.currency.toUpperCase() === e.currency.toUpperCase() &&
        Math.abs(d.grossCents - e.amountCents) <= AMOUNT_TOLERANCE_CENTS &&
        daysBetween(d.date, e.date) <= DATE_TOLERANCE_DAYS,
    );
  const withCands = expenses.map((e) => ({ e, c: candidates(e) }));
  const unmatchedIds = new Set<string>();
  const order = withCands
    .filter((x) => {
      if (x.c.length === 0) unmatchedIds.add(x.e.id);
      return x.c.length > 0;
    })
    .sort((a, b) => a.c.length - b.c.length || cmp(a.e.date, b.e.date) || cmp(a.e.id, b.e.id));

  const used = new Set<string>();
  const matched: { expenseId: string; documentId: string }[] = [];
  for (const { e, c } of order) {
    let best: { d: ReconDocument; sim: number; gap: number } | null = null;
    for (const d of c) {
      if (used.has(d.id)) continue;
      const sim = nameSimilarity(e.text, d.contractorName);
      const gap = daysBetween(d.date, e.date);
      if (!best || sim > best.sim || (sim === best.sim && (gap < best.gap || (gap === best.gap && d.id < best.d.id)))) {
        best = { d, sim, gap };
      }
    }
    if (best) {
      used.add(best.d.id);
      matched.push({ expenseId: e.id, documentId: best.d.id });
    } else {
      unmatchedIds.add(e.id);
    }
  }
  return { matched, unmatched: expenses.filter((e) => unmatchedIds.has(e.id)) };
}
