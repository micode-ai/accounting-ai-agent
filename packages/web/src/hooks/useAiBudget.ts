'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  disconnectAiBudget,
  dismissReconciliationItem,
  fetchAiBudgetCompany,
  fetchAiBudgetPersonal,
  fetchAiBudgetStatus,
  setAiBudgetLabel,
  startAiBudgetConnect,
  triggerAiBudgetSync,
} from '@/lib/api/ai-budget';
import type { AiBudgetCompanyDto, AiBudgetLabel, AiBudgetPersonalDto, AiBudgetStatusDto } from '@/types/ai-budget.types';

const KEYS = [['ai-budget-status'], ['ai-budget-company'], ['ai-budget-personal']] as const;

export function useAiBudgetStatus() {
  return useQuery<AiBudgetStatusDto>({ queryKey: ['ai-budget-status'], queryFn: fetchAiBudgetStatus, staleTime: 30_000 });
}

const isSyncing = (d: AiBudgetCompanyDto | undefined): boolean =>
  !!d && (d.state === 'syncing' || (d.state === 'ready' && d.sync.state === 'syncing'));

export function useAiBudgetCompany(enabled = true) {
  return useQuery<AiBudgetCompanyDto>({
    queryKey: ['ai-budget-company'],
    queryFn: fetchAiBudgetCompany,
    enabled,
    staleTime: 30_000,
    refetchInterval: (query) => (isSyncing(query.state.data) ? 10_000 : false),
  });
}

export function useAiBudgetPersonal(enabled = true) {
  return useQuery<AiBudgetPersonalDto>({
    queryKey: ['ai-budget-personal'],
    queryFn: fetchAiBudgetPersonal,
    enabled,
    staleTime: 30_000,
  });
}

export function useAiBudgetMutations() {
  const qc = useQueryClient();
  const invalidateAll = () => Promise.all(KEYS.map((queryKey) => qc.invalidateQueries({ queryKey })));

  const connect = useMutation({
    mutationFn: startAiBudgetConnect,
    onSuccess: ({ authorizeUrl }) => window.location.assign(authorizeUrl),
  });
  const disconnect = useMutation({ mutationFn: disconnectAiBudget, onSuccess: invalidateAll });
  const setLabel = useMutation({
    mutationFn: ({ accountId, label }: { accountId: string; label: AiBudgetLabel }) => setAiBudgetLabel(accountId, label),
    // Refetch on success AND failure: a 404/409 means the list on screen is stale.
    onSettled: invalidateAll,
  });
  const sync = useMutation({ mutationFn: triggerAiBudgetSync, onSuccess: invalidateAll });
  const dismiss = useMutation({
    mutationFn: ({ expenseId, reason }: { expenseId: string; reason?: string }) => dismissReconciliationItem(expenseId, reason),
    onSuccess: invalidateAll,
  });

  return { connect, disconnect, setLabel, sync, dismiss };
}

export type AiBudgetMutations = ReturnType<typeof useAiBudgetMutations>;
