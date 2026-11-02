import React from 'react';
import { render, screen } from '@testing-library/react';
import { PersonalSummary } from '../PersonalSummary';
import type { AiBudgetPersonalDto } from '@/types/ai-budget.types';
import en from '@/i18n/locales/en.json';

const t = en.aiBudget;

// Recharts' ResponsiveContainer needs ResizeObserver, which jsdom lacks.
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const ready = (over: Partial<Extract<AiBudgetPersonalDto, { state: 'ready' }>> = {}): AiBudgetPersonalDto => ({
  state: 'ready',
  accounts: [{ name: 'Home', currency: 'PLN' }],
  inactiveAccounts: 0,
  failedAccounts: 0,
  truncated: false,
  thisMonth: [{ currency: 'PLN', total: 500 }, { currency: 'USD', total: 40 }],
  trend: [
    { month: '2026-10', totals: [{ currency: 'PLN', total: 400 }] },
    { month: '2026-11', totals: [{ currency: 'PLN', total: 500 }, { currency: 'USD', total: 40 }] },
  ],
  categories: [{ currency: 'PLN', items: [{ categoryId: null, categoryName: null, total: 100 }] }],
  ...over,
});

const renderIt = (data: AiBudgetPersonalDto | undefined, extra: { isError?: boolean } = {}) =>
  render(<PersonalSummary data={data} t={t} locale="en" {...extra} />);

describe('PersonalSummary', () => {
  test('no_private_accounts shows its message', () => {
    renderIt({ state: 'no_private_accounts' });
    expect(screen.getByText(t.personal.noPrivateAccounts)).toBeInTheDocument();
  });

  test('not_connected shows the invite card', () => {
    renderIt({ state: 'not_connected' });
    expect(screen.getByText(t.invite.title)).toBeInTheDocument();
  });

  test('needs_reconnect shows no figures', () => {
    renderIt({ state: 'needs_reconnect' });
    expect(screen.getByText(t.personal.needsReconnect)).toBeInTheDocument();
    expect(screen.queryByText(/\d[,.]\d\d/)).toBeNull();
  });

  test('error state is explicit', () => {
    renderIt({ state: 'error' });
    expect(screen.getByText(t.personal.error)).toBeInTheDocument();
  });

  test('ready shows one line per currency and a trend chart per currency', () => {
    renderIt(ready());
    expect(screen.getByTestId('currency-line-PLN')).toBeInTheDocument();
    expect(screen.getByTestId('currency-line-USD')).toBeInTheDocument();
    expect(screen.getByTestId('trend-chart-PLN')).toBeInTheDocument();
    expect(screen.getByTestId('trend-chart-USD')).toBeInTheDocument();
    expect(screen.queryByText(t.personal.incomplete)).toBeNull();
  });

  test('failedAccounts > 0 shows the incomplete warning with the count', () => {
    renderIt(ready({ failedAccounts: 2 }));
    expect(screen.getByText(new RegExp(t.personal.incomplete))).toBeInTheDocument();
    expect(screen.getByText(/2 accounts could not be read/)).toBeInTheDocument();
  });

  test('truncated shows the partial-data notice', () => {
    renderIt(ready({ truncated: true }));
    expect(screen.getByText(t.personal.truncated)).toBeInTheDocument();
  });
});
