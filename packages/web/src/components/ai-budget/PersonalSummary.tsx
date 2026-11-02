'use client';

import Link from 'next/link';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AiBudgetPersonalDto } from '@/types/ai-budget.types';
import { AiBudgetCategoryChart } from './AiBudgetCategoryChart';
import { AiBudgetInviteCard } from './AiBudgetInviteCard';
import { CurrencyLines } from './CurrencyLines';
import { formatMoney, type AiBudgetT } from './types';

interface Props {
  data: AiBudgetPersonalDto | undefined;
  isLoading?: boolean;
  isError?: boolean;
  t: AiBudgetT;
  locale?: string;
}

const Msg = ({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'warn' }) => (
  <p className={`text-sm ${tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400'}`}>{children}</p>
);

const Card = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700 p-3 space-y-2">{children}</div>
);

export function PersonalSummary({ data, isLoading, isError, t, locale = 'en' }: Props) {
  const p = t.personal;

  if (isLoading) {
    return <div className="animate-pulse bg-gray-200 dark:bg-gray-700 h-40 rounded-lg" />;
  }
  if (isError || !data || data.state === 'error') {
    return (
      <Card>
        <Msg tone="warn">{p.error}</Msg>
      </Card>
    );
  }

  switch (data.state) {
    case 'unavailable':
      return null;
    case 'not_connected':
      return <AiBudgetInviteCard t={t} />;
    case 'needs_reconnect':
      return (
        <Card>
          <Msg tone="warn">{p.needsReconnect}</Msg>
          <Link href="/settings/integrations" className="text-sm text-blue-600 hover:underline">
            {t.settings.reconnect}
          </Link>
        </Card>
      );
    case 'no_private_accounts':
      return (
        <Card>
          <Msg>{p.noPrivateAccounts}</Msg>
        </Card>
      );
    case 'ready': {
      const currencies = Array.from(new Set(data.trend.flatMap((m) => m.totals.map((x) => x.currency))));
      return (
        <div className="space-y-2">
          {(data.failedAccounts > 0 || data.inactiveAccounts > 0) && (
            <Msg tone="warn">
              {p.incomplete}
              {data.failedAccounts > 0 && ` ${t.company.failedAccounts.replace('{count}', String(data.failedAccounts))}`}
            </Msg>
          )}
          {data.truncated && <Msg tone="warn">{p.truncated}</Msg>}
          <Card>
            <p className="text-xs text-gray-500 dark:text-gray-400">{p.thisMonth}</p>
            <CurrencyLines totals={data.thisMonth} locale={locale} />
          </Card>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            <Card>
              <p className="text-xs text-gray-500 dark:text-gray-400">{p.trend}</p>
              {currencies.map((cur) => {
                const rows = data.trend.map((m) => ({ month: m.month, total: m.totals.find((x) => x.currency === cur)?.total ?? 0 }));
                return (
                  <div key={cur} data-testid={`trend-chart-${cur}`}>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{cur}</p>
                    <div style={{ width: '100%', height: 180 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={rows}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} />
                          <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                          <YAxis tick={{ fontSize: 11 }} width={50} />
                          <Tooltip formatter={(v: number) => formatMoney(v, cur, locale)} />
                          <Bar dataKey="total" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                );
              })}
            </Card>
            <Card>
              <p className="text-xs text-gray-500 dark:text-gray-400">{p.byCategory}</p>
              {data.categories.map((g) => (
                <AiBudgetCategoryChart key={g.currency} group={g} uncategorizedLabel={t.company.uncategorized} locale={locale} />
              ))}
            </Card>
          </div>
        </div>
      );
    }
  }
}
