'use client';

import React from 'react';
import { Building2 } from 'lucide-react';
import type { AiBudgetAccountDto } from '@/types/ai-budget.types';
import { isUnavailableAccount } from './AccountLabelSelect';

interface Props {
  accounts: AiBudgetAccountDto[];
  title: string;
  help: string;
  disabled?: boolean;
  onChoose: (accountId: string) => void;
}

/** Shown when several business accounts exist and none is the company yet. Only active, available ones can be chosen. */
export function CompanyChoicePrompt({ accounts, title, help, disabled, onChoose }: Props) {
  const candidates = accounts.filter((a) => a.type === 'business' && a.active && !isUnavailableAccount(a));
  return (
    <div
      data-testid="company-choice-prompt"
      className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-900/20"
    >
      <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">{title}</p>
      <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">{help}</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {candidates.map((a) => (
          <button
            key={a.id}
            type="button"
            disabled={disabled}
            onClick={() => onChoose(a.id)}
            className="flex items-center justify-center gap-2 rounded-lg border border-amber-400 bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
          >
            <Building2 className="h-4 w-4" />
            <span>{a.name}</span>
            <span className="text-xs text-gray-500">{a.currency}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
