// Wire types mirror AI Budget's public API (snake_case); domain types are camelCase.

export type AiBudgetLabel = 'company' | 'other_business' | 'private';
export type AiBudgetLabelSource = 'auto' | 'manual';

export interface PublicExpenseWire {
  id: string;
  amount: string;
  currency: string;
  date: string;
  category_id: string | null;
  description: string | null;
  merchant: string | null;
  category_splits: { category_id: string; amount: string }[];
  is_debt: boolean;
  is_split_receivable: boolean;
  updated_at: string;
  encrypted_fields: string[];
}

/**
 * name/type/base_currency are null when reason === 'role' (AI Budget hides them
 * once the grantor is no longer a member). Such an account is inactive, never
 * labelled company and shown as unavailable.
 */
export interface RemoteAccount {
  id: string;
  name: string | null;
  type: string | null;
  base_currency: string | null;
  access: 'read' | 'read_write';
  active: boolean;
  reason: 'role' | 'encrypted' | 'archived' | null;
}

export interface RemoteCategory {
  id: string;
  name: string | null;
  type: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  account_ids: string[];
}

/** total is in major units, 2 dp. */
export interface CurrencyTotal {
  currency: string;
  total: number;
}
