import type { AiBudgetLabel, AiBudgetLabelSource } from '../services/ai-budget/ai-budget.types';

/** One connected AI Budget account as the settings page sees it. Never carries tokens or sync cursors. */
export interface AiBudgetAccountDto {
  id: string;
  externalId: string;
  /** Empty when AI Budget hides the name (the account is unavailable); the UI localizes it. */
  name: string;
  type: string;
  currency: string;
  access: 'read' | 'read_write';
  active: boolean;
  inactiveReason: string | null;
  label: AiBudgetLabel;
  labelSource: AiBudgetLabelSource;
}

export interface AiBudgetStatusDto {
  /** false when the integration is not configured on this server: the feature is hidden. */
  available: boolean;
  /** null when never connected or disconnected. */
  connection: null | {
    status: 'active' | 'needs_reconnect';
    lastSyncedAt: string | null;
    lastSyncError: string | null;
    needsCompanyChoice: boolean;
    accounts: AiBudgetAccountDto[];
  };
}

// ---- Dashboard (Task 9) ----
import type { CurrencyTotal } from '../services/ai-budget/ai-budget.types';
import type { ReconciliationDto } from '../services/ai-budget/ai-budget-api.types';

export interface CategoryTotalDto { categoryId: string | null; categoryName: string | null; total: number }
export interface CategoryCurrencyGroupDto { currency: string; items: CategoryTotalDto[] }

export type AiBudgetCompanyDto =
  | { state: 'unavailable' } | { state: 'not_connected' } | { state: 'needs_reconnect' }
  | { state: 'no_company_account'; needsCompanyChoice: boolean }
  | { state: 'company_inactive'; accountName: string; reason: string | null }
  | { state: 'syncing' } | { state: 'sync_failed' }
  | {
      state: 'ready';
      account: { name: string; currency: string };
      sync: { state: 'ok' | 'syncing' | 'failed'; lastSyncedAt: string };
      inactiveAccounts: number;
      currentMonth: string;
      /** One line per currency; currencies are never summed together. */
      spending: { currency: string; current: number; previous: number }[];
      categories: CategoryCurrencyGroupDto[];
      reconciliation: ReconciliationDto;
    };

export type AiBudgetPersonalDto =
  | { state: 'unavailable' } | { state: 'not_connected' } | { state: 'needs_reconnect' } | { state: 'no_private_accounts' } | { state: 'error' }
  | {
      state: 'ready';
      accounts: { name: string; currency: string }[];
      inactiveAccounts: number;
      failedAccounts: number;
      truncated: boolean;
      thisMonth: CurrencyTotal[];
      trend: { month: string; totals: CurrencyTotal[] }[];
      categories: CategoryCurrencyGroupDto[];
    };
