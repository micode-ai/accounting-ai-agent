// Copy of packages/api/src/types/ai-budget-api.types.ts (+ the types it imports). Keep in sync.

export type AiBudgetLabel = 'company' | 'other_business' | 'private';
export type AiBudgetLabelSource = 'auto' | 'manual';

export interface CurrencyTotal {
  currency: string;
  total: number;
}

export interface UnmatchedItemDto { expenseId: string; date: string; amount: number; currency: string; merchant: string | null }

export type ReconciliationDto =
  | { state: 'wfirma_not_connected' }
  | { state: 'wfirma_error' }
  | { state: 'no_company' }
  | { state: 'ok'; window: { from: string; to: string }; unmatchedCount: number; unmatchedTotals: CurrencyTotal[]; items: UnmatchedItemDto[]; dismissedCount: number; truncated?: boolean };

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
  available: boolean;
  connection: null | {
    status: 'active' | 'needs_reconnect';
    lastSyncedAt: string | null;
    lastSyncError: string | null;
    needsCompanyChoice: boolean;
    accounts: AiBudgetAccountDto[];
  };
}

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

export interface AiBudgetDisconnectResultDto {
  revokedRemotely: boolean;
  /** revoked | failed (an active grant was not revoked) | expired (the grant was already unusable) | none (nothing stored). */
  remote?: 'revoked' | 'failed' | 'expired' | 'none';
}
