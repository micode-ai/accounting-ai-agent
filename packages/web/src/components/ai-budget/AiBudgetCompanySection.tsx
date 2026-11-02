'use client';

import Link from 'next/link';
import type { AiBudgetCompanyDto } from '@/types/ai-budget.types';
import { AiBudgetCategoryChart } from './AiBudgetCategoryChart';
import { AiBudgetInviteCard } from './AiBudgetInviteCard';
import { CurrencyLines } from './CurrencyLines';
import { ReconciliationCard } from './ReconciliationCard';
import { intlLocale, type AiBudgetT } from './types';

interface Props {
  data: AiBudgetCompanyDto | undefined;
  isLoading?: boolean;
  isError?: boolean;
  onDismiss: (expenseId: string) => void;
  dismissError?: string | null;
  t: AiBudgetT;
  locale?: string;
}

const Shell = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700 p-3 space-y-2">
    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
    {children}
  </div>
);

const Msg = ({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'warn' }) => (
  <p className={`text-sm ${tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400'}`}>{children}</p>
);

export function AiBudgetCompanySection({ data, isLoading, isError, onDismiss, dismissError, t, locale = 'en' }: Props) {
  const c = t.company;

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-100 dark:border-gray-700 p-3">
        <div className="animate-pulse bg-gray-200 dark:bg-gray-700 h-5 w-36 rounded mb-2" />
        <div className="animate-pulse bg-gray-200 dark:bg-gray-700 h-24 rounded-lg" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <Shell title={c.title}>
        <Msg tone="warn">{c.error}</Msg>
      </Shell>
    );
  }

  switch (data.state) {
    case 'unavailable':
      return null;
    case 'not_connected':
      return <AiBudgetInviteCard t={t} />;
    case 'needs_reconnect':
      return (
        <Shell title={c.title}>
          <Msg tone="warn">{c.needsReconnect}</Msg>
          <Link href="/settings/integrations" className="text-sm text-blue-600 hover:underline">
            {t.settings.reconnect}
          </Link>
        </Shell>
      );
    case 'syncing':
      return (
        <Shell title={c.title}>
          <Msg>{c.syncing}</Msg>
        </Shell>
      );
    case 'sync_failed':
      return (
        <Shell title={c.title}>
          <Msg tone="warn">{c.syncFailed}</Msg>
        </Shell>
      );
    case 'no_company_account':
      return (
        <Shell title={c.title}>
          <Msg>{c.noCompanyAccount}</Msg>
          {data.needsCompanyChoice && (
            <Link href="/settings/integrations" className="text-sm text-blue-600 hover:underline">
              {t.settings.chooseCompany}
            </Link>
          )}
        </Shell>
      );
    case 'company_inactive':
      return (
        <Shell title={c.title}>
          <Msg tone="warn">{c.companyInactive}</Msg>
        </Shell>
      );
    case 'ready': {
      const stale = data.sync.state === 'failed';
      return (
        <Shell title={`${c.title} · ${data.account.name}`}>
          {stale && (
            <Msg tone="warn">
              {t.settings.lastSync.replace('{time}', new Date(data.sync.lastSyncedAt).toLocaleString(intlLocale(locale)))}
            </Msg>
          )}
          {data.sync.state === 'syncing' && <Msg>{c.refreshing}</Msg>}
          {data.inactiveAccounts > 0 && <Msg>{c.oneAccountNotRead}</Msg>}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="space-y-3">
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">{c.thisMonth}</p>
                <CurrencyLines totals={data.spending.map((s) => ({ currency: s.currency, total: s.current }))} locale={locale} />
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">{c.lastMonth}</p>
                <CurrencyLines totals={data.spending.map((s) => ({ currency: s.currency, total: s.previous }))} locale={locale} />
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">{c.byCategory}</p>
              {data.categories.map((g) => (
                <AiBudgetCategoryChart key={g.currency} group={g} uncategorizedLabel={c.uncategorized} locale={locale} />
              ))}
            </div>
            <ReconciliationCard data={data.reconciliation} t={t} locale={locale} onDismiss={onDismiss} dismissError={dismissError} />
          </div>
        </Shell>
      );
    }
  }
}
