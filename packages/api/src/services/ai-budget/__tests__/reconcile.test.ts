import { matchExpensesToDocuments, nameSimilarity, normalizeName, type ReconDocument, type ReconExpense } from '../reconcile';

const exp = (id: string, date: string, over: Partial<ReconExpense> = {}): ReconExpense =>
  ({ id, date, amountCents: 12300, currency: 'PLN', text: null, ...over });
const doc = (id: string, date: string, over: Partial<ReconDocument> = {}): ReconDocument =>
  ({ id, date, grossCents: 12300, currency: 'PLN', contractorName: null, ...over });

test('normalizeName strips diacritics, punctuation and legal forms', () => {
  expect(normalizeName('ŁÓDŹ Usługi Sp. z o.o.')).toEqual(['lodz', 'uslugi']);
  expect(normalizeName('ORLEN S.A.')).toEqual(['orlen']);
});

test('nameSimilarity is a token Jaccard and null gives 0', () => {
  expect(nameSimilarity(null, 'x')).toBe(0);
  expect(nameSimilarity('Orlen Stacja', 'ORLEN S.A.')).toBeCloseTo(1 / 2);
});

test('match needs same currency, amount within 0.01 and date within 7 days', () => {
  const e = exp('e1', '2026-11-10', { text: 'Orlen' });
  expect(matchExpensesToDocuments([e], [doc('d1', '2026-11-17', { grossCents: 12301, currency: 'pln', contractorName: 'ORLEN S.A.' })]).matched).toHaveLength(1);
  expect(matchExpensesToDocuments([e], [doc('d1', '2026-11-18')]).unmatched).toEqual([e]);
  expect(matchExpensesToDocuments([e], [doc('d1', '2026-11-10', { grossCents: 12302 })]).unmatched).toEqual([e]);
  expect(matchExpensesToDocuments([e], [doc('d1', '2026-11-10', { currency: 'EUR' })]).unmatched).toEqual([e]);
});

test('a document matches at most one expense', () => {
  const r = matchExpensesToDocuments([exp('e1', '2026-11-10'), exp('e2', '2026-11-11')], [doc('d1', '2026-11-10')]);
  expect(r.matched).toHaveLength(1);
  expect(r.unmatched).toHaveLength(1);
});

test('the contractor name most similar to the merchant wins a tie', () => {
  const r = matchExpensesToDocuments(
    [exp('e1', '2026-11-10', { text: 'Orlen Stacja 123' })],
    [doc('d1', '2026-11-10', { contractorName: 'Shell Polska' }), doc('d2', '2026-11-12', { contractorName: 'ORLEN S.A.' })],
  );
  expect(r.matched).toEqual([{ expenseId: 'e1', documentId: 'd2' }]);
});

test('expenses with fewer candidates are assigned first', () => {
  // e2 (11-16) only reaches d1 (11-12); e1 (11-10) reaches d1 and d2 and prefers d1 by name
  const r = matchExpensesToDocuments(
    [exp('e1', '2026-11-10', { text: 'Shell' }), exp('e2', '2026-11-16')],
    [doc('d1', '2026-11-12', { contractorName: 'Shell' }), doc('d2', '2026-11-04')],
  );
  expect(r.matched).toEqual(expect.arrayContaining([{ expenseId: 'e2', documentId: 'd1' }, { expenseId: 'e1', documentId: 'd2' }]));
  expect(r.unmatched).toHaveLength(0);
});
