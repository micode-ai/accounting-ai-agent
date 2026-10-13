'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getSubscription,
  getPlans,
  getUsage,
  createCheckoutSession,
  createPortalSession,
  cancelSubscription,
  setLLMPreference,
  SubscriptionDetails,
  PricingPlan,
  UsageLimits,
} from '@/lib/api/subscription';

interface UseSubscriptionReturn {
  // Subscription data
  subscription: SubscriptionDetails | undefined;
  plans: PricingPlan[] | undefined;
  usage: UsageLimits | undefined;

  // Computed properties
  isPro: boolean;
  isFree: boolean;
  isActive: boolean;
  hasOwnLLMKey: boolean;
  useOwnLLMKey: boolean;

  // Loading states
  isLoading: boolean;
  isLoadingPlans: boolean;
  isCheckingOut: boolean;

  // Errors
  error: Error | null;
  checkoutError: Error | null;

  // Actions
  checkout: (priceId: string) => void;
  openBillingPortal: () => void;
  cancel: () => void;
  toggleLLMPreference: (useOwnKey: boolean) => void;
  refetch: () => void;
}

interface UseSubscriptionOptions {
  skipSubscription?: boolean;
}

export function useSubscription(options?: UseSubscriptionOptions): UseSubscriptionReturn {
  const queryClient = useQueryClient();
  const skipSubscription = options?.skipSubscription ?? false;

  // Fetch subscription details (only for authenticated users)
  const {
    data: subscription,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['subscription'],
    queryFn: getSubscription,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 2,
    enabled: !skipSubscription,
  });

  // Fetch available plans (public endpoint, cached longer)
  const { data: plans, isLoading: isLoadingPlans } = useQuery({
    queryKey: ['subscription-plans'],
    queryFn: getPlans,
    staleTime: 60 * 60 * 1000, // 1 hour
    retry: 2,
  });

  // Fetch usage (optional, more frequent)
  const { data: usage } = useQuery({
    queryKey: ['subscription-usage'],
    queryFn: getUsage,
    staleTime: 1 * 60 * 1000, // 1 minute
    enabled: !!subscription && !skipSubscription,
  });

  // Checkout mutation
  const checkoutMutation = useMutation({
    mutationFn: (priceId: string) => createCheckoutSession(priceId),
    onSuccess: (data) => {
      // Redirect to Stripe Checkout
      window.location.href = data.checkoutUrl;
    },
  });

  // Billing portal mutation
  const portalMutation = useMutation({
    mutationFn: createPortalSession,
    onSuccess: (data) => {
      // Redirect to Stripe Billing Portal
      window.location.href = data.portalUrl;
    },
  });

  // Cancel mutation
  const cancelMutation = useMutation({
    mutationFn: cancelSubscription,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscription'] });
    },
  });

  // LLM preference mutation
  const llmPreferenceMutation = useMutation({
    mutationFn: (useOwnKey: boolean) => setLLMPreference(useOwnKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscription'] });
    },
  });

  // Computed properties
  const isPro = subscription?.plan === 'pro';
  const isFree = subscription?.plan === 'free';
  const isActive = subscription?.status === 'active' || subscription?.status === 'trialing';
  const hasOwnLLMKey = subscription?.hasOwnLLMKey ?? false;
  const useOwnLLMKey = subscription?.useOwnLLMKey ?? false;

  return {
    // Data
    subscription,
    plans,
    usage: usage || subscription?.usage,

    // Computed
    isPro,
    isFree,
    isActive,
    hasOwnLLMKey,
    useOwnLLMKey,

    // Loading states
    isLoading: skipSubscription ? isLoadingPlans : isLoading,
    isLoadingPlans,
    isCheckingOut: checkoutMutation.isPending,

    // Errors
    error: error as Error | null,
    checkoutError: checkoutMutation.error,

    // Actions
    checkout: checkoutMutation.mutate,
    openBillingPortal: portalMutation.mutate,
    cancel: cancelMutation.mutate,
    toggleLLMPreference: llmPreferenceMutation.mutate,
    refetch,
  };
}
