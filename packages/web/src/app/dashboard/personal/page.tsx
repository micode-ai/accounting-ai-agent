'use client';

import Link from 'next/link';
import { ArrowLeft, Lock, RefreshCw } from 'lucide-react';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AppHeader } from '@/components/layout/AppHeader';
import { PersonalSummary } from '@/components/ai-budget/PersonalSummary';
import { useLocale } from '@/contexts/LocaleContext';
import { useAiBudgetPersonal, useAiBudgetStatus } from '@/hooks/useAiBudget';
import enTranslations from '@/i18n/locales/en.json';
import plTranslations from '@/i18n/locales/pl.json';
import ruTranslations from '@/i18n/locales/ru.json';

const translations = {
  en: enTranslations,
  pl: plTranslations,
  ru: ruTranslations,
};

export default function PersonalDashboardPage() {
  return (
    <ProtectedRoute>
      <PersonalDashboardContent />
    </ProtectedRoute>
  );
}

function PersonalDashboardContent() {
  const { locale } = useLocale();
  const t = translations[locale];
  const aib = t.aiBudget;

  const status = useAiBudgetStatus();
  const available = status.data?.available === true;
  const personal = useAiBudgetPersonal(available);

  return (
    <div className="h-dvh flex flex-col bg-gray-50 dark:bg-gray-900">
      <AppHeader
        title={aib.personal.title}
        leading={
          <Link
            href="/dashboard"
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title={t.dashboard.title}
          >
            <ArrowLeft className="h-4 w-4 text-gray-600 dark:text-gray-400" />
          </Link>
        }
        actions={
          <button
            onClick={() => personal.refetch()}
            disabled={personal.isFetching}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
            title={t.dashboard.refresh}
          >
            <RefreshCw className={`h-4 w-4 text-gray-600 dark:text-gray-400 ${personal.isFetching ? 'animate-spin' : ''}`} />
          </button>
        }
      />
      <main className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-2 space-y-2">
          <div className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400">
            <Lock className="h-4 w-4 mt-0.5 shrink-0" />
            <p>{aib.personal.subtitle}</p>
          </div>
          {status.isLoading ? (
            <div className="animate-pulse bg-gray-200 dark:bg-gray-700 h-40 rounded-lg" />
          ) : status.isError ? (
            <p className="text-sm text-amber-700 dark:text-amber-400">{aib.personal.error}</p>
          ) : available ? (
            <PersonalSummary
              data={personal.data}
              isLoading={personal.isLoading}
              isError={personal.isError}
              t={aib}
              locale={locale}
            />
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">{aib.settings.error.unavailable}</p>
          )}
        </div>
      </main>
    </div>
  );
}
