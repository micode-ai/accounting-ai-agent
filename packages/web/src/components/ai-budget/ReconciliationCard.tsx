'use client';

import type { ReconciliationDto } from '@/types/ai-budget.types';
import { CurrencyLines } from './CurrencyLines';
import { formatMoney, intlLocale, type AiBudgetT } from './types';

interface Props {
  data: ReconciliationDto;
  t: AiBudgetT;
  locale: string;
  onDismiss: (expenseId: string) => void;
  dismissError?: string | null;
}

const MAX_ITEMS = 5;

export function ReconciliationCard({ data, t, locale, onDismiss, dismissError }: Props) {
  const r = t.reconciliation;
  let body: React.ReactNode;

  if (data.state === 'wfirma_not_connected') {
    body = <p className="text-sm text-gray-500 dark:text-gray-400">{r.wfirmaNeeded}</p>;
  } else if (data.state === 'wfirma_error') {
    body = <p className="text-sm text-red-600 dark:text-red-400">{r.wfirmaError}</p>;
  } else if (data.state === 'no_company') {
    body = <p className="text-sm text-gray-500 dark:text-gray-400">{r.noCompany}</p>;
  } else if (data.unmatchedCount === 0) {
    body = (
      <>
        <p className="text-sm text-green-700 dark:text-green-400">{r.allMatched}</p>
        {data.truncated && <p className="text-xs text-amber-600 mt-1">{r.truncated}</p>}
      </>
    );
  } else {
    body = (
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm text-gray-700 dark:text-gray-300">{r.count.replace('{count}', String(data.unmatchedCount))}</p>
          <div className="text-right">
            <p className="text-xs text-gray-500 dark:text-gray-400">{r.total}</p>
            <CurrencyLines totals={data.unmatchedTotals} locale={locale} />
          </div>
        </div>
        {data.truncated && <p className="text-xs text-amber-600">{r.truncated}</p>}
        <ul className="divide-y divide-gray-100 dark:divide-gray-700">
          {data.items.slice(0, MAX_ITEMS).map((item) => (
            <li key={item.expenseId} className="py-1.5 flex items-center justify-between gap-2 text-sm">
              <div className="min-w-0">
                <p className="text-gray-900 dark:text-gray-100 truncate">{item.merchant ?? '—'}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {new Date(`${item.date}T12:00:00`).toLocaleDateString(intlLocale(locale))} · {formatMoney(item.amount, item.currency, locale)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onDismiss(item.expenseId)}
                className="shrink-0 text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                {r.dismiss}
              </button>
            </li>
          ))}
        </ul>
        {dismissError && <p className="text-xs text-red-600 dark:text-red-400">{dismissError}</p>}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-100 dark:border-gray-700 p-3" data-testid="reconciliation-card">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{r.title}</h4>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{r.subtitle}</p>
      {body}
    </div>
  );
}
