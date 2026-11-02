'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CategoryCurrencyGroupDto } from '@/types/ai-budget.types';
import { formatMoney } from './types';

interface Props {
  group: CategoryCurrencyGroupDto;
  uncategorizedLabel: string;
  locale: string;
}

/** Horizontal bar chart of one currency's categories. One chart per currency. */
export function AiBudgetCategoryChart({ group, uncategorizedLabel, locale }: Props) {
  const rows = group.items.map((i) => ({ name: i.categoryName ?? uncategorizedLabel, total: i.total }));
  const height = Math.max(120, rows.length * 28 + 24);
  return (
    <div data-testid={`category-chart-${group.currency}`}>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">{group.currency}</p>
      <div style={{ width: '100%', height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v: number) => formatMoney(v, group.currency, locale)} />
            <Bar dataKey="total" fill="#3b82f6" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
