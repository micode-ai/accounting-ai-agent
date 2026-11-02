'use client';

import React from 'react';
import type { AiBudgetAccountDto, AiBudgetLabel } from '@/types/ai-budget.types';

export interface AiBudgetSettingsTranslations {
  settings: {
    labelAuto: string;
    labelManual: string;
    labelFor: string;
    [key: string]: unknown;
  };
  labels: Record<AiBudgetLabel, string>;
}

const LABELS: AiBudgetLabel[] = ['company', 'other_business', 'private'];

/** AI Budget hides the name and type of an account its grantor can no longer see. */
export const isUnavailableAccount = (a: Pick<AiBudgetAccountDto, 'name' | 'type'>): boolean => !a.name && !a.type;

interface Props {
  account: AiBudgetAccountDto;
  translations: AiBudgetSettingsTranslations;
  disabled?: boolean;
  onChange: (label: AiBudgetLabel) => void;
}

export function AccountLabelSelect({ account, translations, disabled, onChange }: Props) {
  const unavailable = isUnavailableAccount(account);
  const name = account.name || '';
  return (
    <div className="flex flex-col gap-1 sm:items-end">
      <select
        aria-label={translations.settings.labelFor.replace('{name}', name)}
        value={account.label}
        disabled={disabled || unavailable}
        onChange={(e) => onChange(e.target.value as AiBudgetLabel)}
        className="h-9 w-full sm:w-44 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 [color-scheme:light] dark:[color-scheme:dark]"
      >
        {LABELS.map((l) => (
          <option key={l} value={l}>
            {translations.labels[l]}
          </option>
        ))}
      </select>
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {account.labelSource === 'manual' ? translations.settings.labelManual : translations.settings.labelAuto}
      </span>
    </div>
  );
}
