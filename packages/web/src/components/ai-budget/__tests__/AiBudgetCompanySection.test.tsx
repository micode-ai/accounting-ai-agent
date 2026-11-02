import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AiBudgetCompanySection } from '../AiBudgetCompanySection';
import type { AiBudgetCompanyDto, ReconciliationDto } from '@/types/ai-budget.types';
import en from '@/i18n/locales/en.json';

const t = en.aiBudget;

// Recharts' ResponsiveContainer needs ResizeObserver, which jsdom lacks.
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const ready = (over: Partial<Extract<AiBudgetCompanyDto, { state: 'ready' }>> = {}): AiBudgetCompanyDto => ({
  state: 'ready',
  account: { name: 'Acme', currency: 'PLN' },
  sync: { state: 'ok', lastSyncedAt: '2026-11-01T10:00:00.000Z' },
  inactiveAccounts: 0,
  currentMonth: '2026-11',
  spending: [
    { currency: 'PLN', current: 1234.5, previous: 800 },
    { currency: 'EUR', current: 50, previous: 20 },
  ],
  categories: [{ currency: 'PLN', items: [{ categoryId: 'c1', categoryName: 'Food', total: 100 }] }],
  reconciliation: { state: 'ok', window: { from: '2026-10-01', to: '2026-11-02' }, unmatchedCount: 0, unmatchedTotals: [], items: [], dismissedCount: 0 },
  ...over,
});

const renderSection = (data: AiBudgetCompanyDto, onDismiss = jest.fn()) => {
  render(<AiBudgetCompanySection data={data} onDismiss={onDismiss} t={t} locale="en" />);
  return onDismiss;
};

describe('AiBudgetCompanySection', () => {
  test('unavailable renders nothing', () => {
    const { container } = render(<AiBudgetCompanySection data={{ state: 'unavailable' }} onDismiss={jest.fn()} t={t} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('not_connected renders the invite card', () => {
    renderSection({ state: 'not_connected' });
    expect(screen.getByText(t.invite.title)).toBeInTheDocument();
  });

  test('syncing shows the syncing message and no 0,00 figure', () => {
    renderSection({ state: 'syncing' });
    expect(screen.getByText(t.company.syncing)).toBeInTheDocument();
    expect(screen.queryByText(/0[,.]00/)).toBeNull();
  });

  test('sync_failed shows an explicit message and no figures', () => {
    renderSection({ state: 'sync_failed' });
    expect(screen.getByText(t.company.syncFailed)).toBeInTheDocument();
    expect(screen.queryByText(/0[,.]00/)).toBeNull();
  });

  test('needs_reconnect shows reconnect, never figures', () => {
    renderSection({ state: 'needs_reconnect' });
    expect(screen.getByText(t.company.needsReconnect)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: t.settings.reconnect })).toHaveAttribute('href', '/settings/integrations');
    expect(screen.queryByText(/\d[,.]\d\d/)).toBeNull();
  });

  test('no_company_account offers the choose link only when needsCompanyChoice', () => {
    renderSection({ state: 'no_company_account', needsCompanyChoice: true });
    expect(screen.getByRole('link', { name: t.settings.chooseCompany })).toBeInTheDocument();
  });

  test('no_company_account without a choice has no link', () => {
    renderSection({ state: 'no_company_account', needsCompanyChoice: false });
    expect(screen.queryByRole('link')).toBeNull();
  });

  test('company_inactive shows its text', () => {
    renderSection({ state: 'company_inactive', accountName: 'Acme', reason: null });
    expect(screen.getByText(t.company.companyInactive)).toBeInTheDocument();
  });

  test('ready with PLN and EUR renders two currency lines per period and a chart per currency group', () => {
    renderSection(ready());
    expect(screen.getAllByTestId('currency-line-PLN')).toHaveLength(2);
    expect(screen.getAllByTestId('currency-line-EUR')).toHaveLength(2);
    expect(screen.getByTestId('category-chart-PLN')).toBeInTheDocument();
  });

  test('failed sync marks the figures with their last sync time; inactive accounts are flagged', () => {
    renderSection(ready({ sync: { state: 'failed', lastSyncedAt: '2026-11-01T10:00:00.000Z' }, inactiveAccounts: 1 }));
    expect(screen.getByText(/Last sync:/)).toBeInTheDocument();
    expect(screen.getByText(t.company.oneAccountNotRead)).toBeInTheDocument();
  });

  test('a sync in progress over a completed mirror is announced', () => {
    renderSection(ready({ sync: { state: 'syncing', lastSyncedAt: '2026-11-01T10:00:00.000Z' } }));
    expect(screen.getByText(t.company.refreshing)).toBeInTheDocument();
  });

  test('wfirma_not_connected explains wFirma is needed', () => {
    renderSection(ready({ reconciliation: { state: 'wfirma_not_connected' } }));
    expect(screen.getByText(t.reconciliation.wfirmaNeeded)).toBeInTheDocument();
    expect(screen.queryByText(t.reconciliation.allMatched)).toBeNull();
  });

  test('wfirma_error never says all matched', () => {
    renderSection(ready({ reconciliation: { state: 'wfirma_error' } }));
    expect(screen.getByText(t.reconciliation.wfirmaError)).toBeInTheDocument();
    expect(screen.queryByText(t.reconciliation.allMatched)).toBeNull();
  });

  test('ok with zero unmatched shows allMatched', () => {
    renderSection(ready());
    expect(screen.getByText(t.reconciliation.allMatched)).toBeInTheDocument();
  });

  const unmatched = (n: number): ReconciliationDto => ({
    state: 'ok',
    window: { from: '2026-10-01', to: '2026-11-02' },
    unmatchedCount: n,
    unmatchedTotals: [{ currency: 'PLN', total: 300 }, { currency: 'EUR', total: 20 }],
    items: Array.from({ length: n }, (_, i) => ({ expenseId: `e${i}`, date: '2026-10-15', amount: 10 + i, currency: 'PLN', merchant: `Shop ${i}` })),
    dismissedCount: 0,
  });

  test('unmatched shows the count, per-currency totals and at most 5 items', () => {
    renderSection(ready({ reconciliation: unmatched(7) }));
    const card = within(screen.getByTestId('reconciliation-card'));
    expect(card.getByText('7 expenses')).toBeInTheDocument();
    expect(card.getAllByRole('button', { name: t.reconciliation.dismiss })).toHaveLength(5);
    expect(card.getByTestId('currency-line-EUR')).toBeInTheDocument();
  });

  test('dismiss button calls onDismiss(expenseId)', () => {
    const onDismiss = renderSection(ready({ reconciliation: unmatched(2) }));
    fireEvent.click(screen.getAllByRole('button', { name: t.reconciliation.dismiss })[1]);
    expect(onDismiss).toHaveBeenCalledWith('e1');
  });

  test('a load error is explicit, not empty', () => {
    render(<AiBudgetCompanySection data={undefined} isError onDismiss={jest.fn()} t={t} />);
    expect(screen.getByText(t.company.error)).toBeInTheDocument();
  });
});
