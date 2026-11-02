import type { CurrencyTotal } from './ai-budget.types';

export interface UnmatchedItemDto { expenseId: string; date: string; amount: number; currency: string; merchant: string | null }

export type ReconciliationDto =
  | { state: 'wfirma_not_connected' }
  | { state: 'wfirma_error' }
  | { state: 'no_company' }
  | { state: 'ok'; window: { from: string; to: string }; unmatchedCount: number; unmatchedTotals: CurrencyTotal[]; items: UnmatchedItemDto[]; dismissedCount: number; truncated?: boolean };

/** Full unmatched list; anything but 'ok' means unknown, never "all matched". */
export type UnmatchedListResult =
  | { state: 'ok'; items: UnmatchedItemDto[]; truncated: boolean }
  | { state: 'wfirma_not_connected' | 'wfirma_error' | 'no_company' };
