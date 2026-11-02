'use client';

import React, { useState } from 'react';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AiBudgetAccountDto, AiBudgetLabel, AiBudgetStatusDto } from '@/types/ai-budget.types';
import { AccountLabelSelect, isUnavailableAccount, type AiBudgetSettingsTranslations } from './AccountLabelSelect';
import { CompanyChoicePrompt } from './CompanyChoicePrompt';
import { ownText } from './notices';

interface MutationLike<V = void> {
  mutate: (variables: V) => void;
  isPending: boolean;
}

export interface AiBudgetCardMutations {
  connect: MutationLike;
  disconnect: MutationLike;
  setLabel: MutationLike<{ accountId: string; label: AiBudgetLabel }>;
  sync: MutationLike;
}

export interface AiBudgetCardTranslations extends AiBudgetSettingsTranslations {
  settings: AiBudgetSettingsTranslations['settings'] & {
    title: string;
    connect: string;
    reconnect: string;
    disconnect: string;
    disconnectConfirm: string;
    status: { active: string; needs_reconnect: string };
    lastSync: string;
    never: string;
    readOnly: string;
    inactive: string;
    inactiveReason: Record<string, string>;
    chooseCompany: string;
    chooseCompanyHelp: string;
    unavailable: string;
    reconnectBanner: string;
    syncNow: string;
    cancel: string;
    accountsTitle: string;
    error: { unavailable: string };
  };
}

interface Props {
  status: AiBudgetStatusDto;
  translations: AiBudgetCardTranslations;
  mutations: AiBudgetCardMutations;
  locale: string;
  /** Inline message from the `?ai_budget=` redirect, already localized. */
  notice?: { kind: 'success' | 'error'; text: string } | null;
  labelError?: string | null;
}

export function AiBudgetIntegrationCard({ status, translations, mutations, locale, notice, labelError }: Props) {
  const s = translations.settings;
  const [confirming, setConfirming] = useState(false);

  if (!status.available) {
    return (
      <p role="status" className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
        {s.error.unavailable}
      </p>
    );
  }

  const noticeEl = notice ? (
    <p
      role="status"
      className={`rounded-lg px-3 py-2 text-sm ${
        notice.kind === 'success'
          ? 'bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300'
          : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'
      }`}
    >
      {notice.text}
    </p>
  ) : null;

  const connection = status.connection;
  if (!connection) {
    return (
      <div className="flex flex-col gap-4">
        {noticeEl}
        <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{s.title}</h2>
          <Button className="mt-4 w-full sm:w-auto" onClick={() => mutations.connect.mutate()} disabled={mutations.connect.isPending}>
            {mutations.connect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {s.connect}
          </Button>
        </div>
      </div>
    );
  }

  const needsReconnect = connection.status === 'needs_reconnect';
  const lastSync = connection.lastSyncedAt
    ? s.lastSync.replace('{time}', new Date(connection.lastSyncedAt).toLocaleString(locale))
    : s.lastSync.replace('{time}', s.never);

  const reasonText = (a: AiBudgetAccountDto): string | null => {
    if (a.active) return null;
    return ownText(s.inactiveReason, a.inactiveReason) || s.inactive;
  };

  return (
    <div className="flex flex-col gap-4">
      {noticeEl}
      {labelError && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">
          {labelError}
        </p>
      )}

      {connection.needsCompanyChoice && (
        <CompanyChoicePrompt
          accounts={connection.accounts}
          title={s.chooseCompany}
          help={s.chooseCompanyHelp}
          disabled={mutations.setLabel.isPending}
          onChoose={(accountId) => mutations.setLabel.mutate({ accountId, label: 'company' })}
        />
      )}

      {needsReconnect && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-700 dark:bg-red-900/20 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{s.reconnectBanner}</span>
        </div>
      )}

      <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{s.title}</h2>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  needsReconnect
                    ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                    : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                }`}
              >
                {ownText(s.status, connection.status) ?? connection.status}
              </span>
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{lastSync}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!needsReconnect && (
              <Button variant="outline" size="sm" onClick={() => mutations.sync.mutate()} disabled={mutations.sync.isPending}>
                <RefreshCw className={`mr-2 h-4 w-4 ${mutations.sync.isPending ? 'animate-spin' : ''}`} />
                {s.syncNow}
              </Button>
            )}
            <Button
              variant={needsReconnect ? 'default' : 'outline'}
              size="sm"
              onClick={() => mutations.connect.mutate()}
              disabled={mutations.connect.isPending}
            >
              {s.reconnect}
            </Button>
          </div>
        </div>

        <h3 className="mt-5 text-sm font-medium text-gray-700 dark:text-gray-300">{s.accountsTitle}</h3>
        <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-700">
          {connection.accounts.map((a) => {
            const unavailable = isUnavailableAccount(a);
            const reason = reasonText(a);
            return (
              <li key={a.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`truncate text-sm font-medium ${unavailable ? 'italic text-gray-500' : 'text-gray-900 dark:text-gray-100'}`}>
                      {unavailable ? s.unavailable : a.name}
                    </span>
                    {a.currency && <span className="text-xs text-gray-500 dark:text-gray-400">{a.currency}</span>}
                    {a.access === 'read' && (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                        {s.readOnly}
                      </span>
                    )}
                  </div>
                  {reason && <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">{reason}</p>}
                </div>
                <AccountLabelSelect
                  account={a}
                  translations={translations}
                  disabled={mutations.setLabel.isPending}
                  onChange={(label) => mutations.setLabel.mutate({ accountId: a.id, label })}
                />
              </li>
            );
          })}
        </ul>

        <div className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-700">
          {confirming ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-gray-700 dark:text-gray-300">{s.disconnectConfirm}</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  variant="outline"
                  size="sm"
                  className="border-red-300 text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300"
                  disabled={mutations.disconnect.isPending}
                  onClick={() => {
                    mutations.disconnect.mutate();
                    setConfirming(false);
                  }}
                >
                  {s.disconnect}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  {s.cancel}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="text-red-700 dark:text-red-300" onClick={() => setConfirming(true)}>
              {s.disconnect}
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
