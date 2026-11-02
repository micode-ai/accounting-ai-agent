import { toCents, centsToNumber, isSpending, attributeToCategories, sumByCurrency, warsawToday, warsawMonthWindow, addDays } from '../ai-budget.domain';

test('toCents parses AI Budget decimal strings', () => { expect(toCents('42.50')).toBe(4250); expect(toCents('0.01')).toBe(1); expect(toCents('7')).toBe(700); });
test('toCents handles negatives, one decimal and rounding noise', () => {
  expect(toCents('-1.5')).toBe(-150);
  expect(toCents('19.99')).toBe(1999);
  expect(toCents('1.005')).toBe(101);
});
test('centsToNumber returns major units', () => { expect(centsToNumber(1005)).toBe(10.05); });
test('debts and split receivables are not spending', () => {
  expect(isSpending({ isDebt: true, isSplitReceivable: false })).toBe(false);
  expect(isSpending({ isDebt: false, isSplitReceivable: true })).toBe(false);
  expect(isSpending({ isDebt: false, isSplitReceivable: false })).toBe(true);
});
test('splits decide and the own category is ignored', () => {
  expect(attributeToCategories({ amountCents: 10000, categoryId: 'food', categorySplits: [
    { categoryId: 'alcohol', amountCents: 3000 }, { categoryId: 'household', amountCents: 5000 }] }))
    .toEqual([{ categoryId: 'alcohol', amountCents: 3000 }, { categoryId: 'household', amountCents: 5000 }]);
});
test('without splits the own category takes the whole amount', () => {
  expect(attributeToCategories({ amountCents: 4250, categoryId: 'food', categorySplits: [] })).toEqual([{ categoryId: 'food', amountCents: 4250 }]);
});
test('mixed currencies are never summed', () => {
  expect(sumByCurrency([{ currency: 'PLN', amountCents: 1000 }, { currency: 'eur', amountCents: 250 }, { currency: 'PLN', amountCents: 5 }]))
    .toEqual([{ currency: 'EUR', total: 2.5 }, { currency: 'PLN', total: 10.05 }]);
});
test('month boundary uses Europe/Warsaw', () => {
  const now = new Date('2026-11-30T23:30:00Z');
  expect(warsawToday(now)).toBe('2026-12-01');
  expect(warsawMonthWindow(now, 0)).toEqual({ from: '2026-12-01', to: '2026-12-31', month: '2026-12' });
  expect(warsawMonthWindow(now, -1)).toEqual({ from: '2026-11-01', to: '2026-11-30', month: '2026-11' });
});
test('month window crosses year boundary and leap February', () => {
  expect(warsawMonthWindow(new Date('2028-01-15T12:00:00Z'), -1)).toEqual({ from: '2027-12-01', to: '2027-12-31', month: '2027-12' });
  expect(warsawMonthWindow(new Date('2028-03-15T12:00:00Z'), -1)).toEqual({ from: '2028-02-01', to: '2028-02-29', month: '2028-02' });
  expect(warsawMonthWindow(new Date('2026-02-10T12:00:00Z'), -5)).toEqual({ from: '2025-09-01', to: '2025-09-30', month: '2025-09' });
});
test('addDays moves across month ends', () => {
  expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
  expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
});
