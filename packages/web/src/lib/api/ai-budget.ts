import { apiClient } from './api-client';
import { API_ENDPOINTS } from './endpoints';
import type {
  AiBudgetCompanyDto,
  AiBudgetDisconnectResultDto,
  AiBudgetLabel,
  AiBudgetPersonalDto,
  AiBudgetStatusDto,
} from '@/types/ai-budget.types';

const E = API_ENDPOINTS.AI_BUDGET;

export const fetchAiBudgetStatus = (): Promise<AiBudgetStatusDto> => apiClient.get<AiBudgetStatusDto>(E.STATUS);

export const startAiBudgetConnect = (): Promise<{ authorizeUrl: string }> =>
  apiClient.post<{ authorizeUrl: string }>(E.CONNECT);

/** Exchanges the one-time code. Rejects with an ApiError whose `code` is the reason (invalid_state, state_mismatch…). */
export const completeAiBudgetConnect = (code: string, state: string): Promise<{ connected: boolean }> =>
  apiClient.post<{ connected: boolean }>(E.COMPLETE, { code, state });

export const disconnectAiBudget = (): Promise<AiBudgetDisconnectResultDto> =>
  apiClient.post<AiBudgetDisconnectResultDto>(E.DISCONNECT);

/** The server answers with the refreshed account list; callers refetch the status instead of relying on it. */
export const setAiBudgetLabel = (accountId: string, label: AiBudgetLabel): Promise<unknown> =>
  apiClient.patch<unknown>(E.LABEL(accountId), { label });

export const triggerAiBudgetSync = (): Promise<{ started: boolean }> =>
  apiClient.post<{ started: boolean }>(E.SYNC);

export const fetchAiBudgetCompany = (): Promise<AiBudgetCompanyDto> =>
  apiClient.get<AiBudgetCompanyDto>(API_ENDPOINTS.DASHBOARD.AI_BUDGET);

export const fetchAiBudgetPersonal = (): Promise<AiBudgetPersonalDto> =>
  apiClient.get<AiBudgetPersonalDto>(API_ENDPOINTS.DASHBOARD.PERSONAL);

export const dismissReconciliationItem = async (expenseId: string, reason?: string): Promise<void> => {
  await apiClient.post(E.DISMISS, { expenseId, reason });
};
