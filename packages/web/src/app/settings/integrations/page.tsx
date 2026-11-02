'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AppHeader } from '@/components/layout/AppHeader';
import { AiBudgetIntegrationCard } from '@/components/ai-budget';
import { useLocale } from '@/contexts/LocaleContext';
import { useAiBudgetMutations, useAiBudgetStatus } from '@/hooks/useAiBudget';
import { ApiError } from '@/lib/api/api-client';
import { disconnectNotice as toDisconnectNotice, redirectNotice as toRedirectNotice, type Notice } from '@/components/ai-budget/notices';
import en from '@/i18n/locales/en.json';
import pl from '@/i18n/locales/pl.json';
import ru from '@/i18n/locales/ru.json';

const translations = { en, pl, ru };

export default function IntegrationsPage() {
  return (
    <ProtectedRoute>
      <IntegrationsContent />
    </ProtectedRoute>
  );
}

function IntegrationsContent() {
  const { locale } = useLocale();
  const t = translations[locale].aiBudget;
  const status = useAiBudgetStatus();
  const mutations = useAiBudgetMutations();
  const [redirectNotice, setRedirectNotice] = useState<Notice>(null);
  const [disconnectNotice, setDisconnectNotice] = useState<Notice>(null);

  // The `?ai_budget=` result of the OAuth round trip is shown once, then dropped from the URL.
  useEffect(() => {
    const n = toRedirectNotice(window.location.search, t);
    if (!n) return;
    setRedirectNotice(n);
    window.history.replaceState(null, '', window.location.pathname);
  }, [t]);

  const labelError = mutations.setLabel.error
    ? mutations.setLabel.error instanceof ApiError && mutations.setLabel.error.statusCode === 409
      ? t.settings.accountUnavailableConflict
      : t.settings.accountLabelFailed
    : null;

  const notice: Notice = disconnectNotice ?? redirectNotice;

  const cardMutations = {
    connect: mutations.connect,
    setLabel: mutations.setLabel,
    sync: mutations.sync,
    disconnect: {
      isPending: mutations.disconnect.isPending,
      mutate: () =>
        mutations.disconnect.mutate(undefined, {
          onSuccess: (r) => setDisconnectNotice(toDisconnectNotice(r, t)),
        }),
    },
  };

  return (
    <div className="h-dvh flex flex-col bg-gray-50 dark:bg-gray-900">
      <AppHeader
        title={t.settings.pageTitle}
        leading={
          <Link
            href="/chat"
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            aria-label={translations[locale].dashboard.backToChat}
          >
            <ArrowLeft className="h-4 w-4 text-gray-600 dark:text-gray-400" />
          </Link>
        }
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
          <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">{t.settings.intro}</p>
          {status.isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            </div>
          ) : status.data ? (
            <AiBudgetIntegrationCard
              status={status.data}
              translations={t}
              mutations={cardMutations}
              locale={locale}
              notice={notice}
              labelError={labelError}
            />
          ) : (
            <p role="alert" className="text-sm text-red-600">
              {t.settings.error.unknown}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
