'use client';

import type { CurrencyTotal } from '@/types/ai-budget.types';
import { formatMoney } from './types';

/** One line per currency. Currencies are never summed together. */
export function CurrencyLines({ totals, locale }: { totals: CurrencyTotal[]; locale: string }) {
  return (
    <div className="space-y-0.5">
      {totals.map((c) => (
        <p key={c.currency} className="text-lg font-semibold text-gray-900 dark:text-gray-100" data-testid={`currency-line-${c.currency}`}>
          {formatMoney(c.total, c.currency, locale)}
        </p>
      ))}
    </div>
  );
}
