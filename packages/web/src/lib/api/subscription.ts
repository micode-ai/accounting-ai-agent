import { apiClient } from './api-client';

// ============================================
// TYPES
// ============================================

export type SubscriptionPlan = 'free' | 'pro';
export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'trialing';

export interface SubscriptionFeatures {
  aiMessagesLimit: number | null;
  wfirmaRequestsLimit: number | null;
  wfirmaIntegration: boolean;
  prioritySupport: boolean;
  requiresOwnLLMKey: boolean;
}

export interface UsageLimits {
  aiMessages: {
    used: number;
    limit: number | null;
    resetAt: string | null;
  };
  wfirmaRequests: {
    used: number;
    limit: number | null;
    resetAt: string | null;
  };
}

export interface SubscriptionDetails {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  features: SubscriptionFeatures;
  usage: UsageLimits;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  useOwnLLMKey: boolean;
  hasOwnLLMKey: boolean;
}

export interface PricingPlan {
  id: SubscriptionPlan;
  name: string;
  description: string;
  priceMonthly: number;
  priceYearly: number;
  features: string[];
  highlighted?: boolean;
}

export interface CheckoutSessionResponse {
  checkoutUrl: string;
  sessionId: string;
}

export interface BillingPortalResponse {
  portalUrl: string;
}

// ============================================
// API FUNCTIONS
// ============================================

/**
 * Get current user's subscription details
 */
export const getSubscription = async (): Promise<SubscriptionDetails> => {
  return apiClient.get<SubscriptionDetails>('/api/subscription');
};

/**
 * Get available subscription plans (public endpoint)
 */
export const getPlans = async (): Promise<PricingPlan[]> => {
  return apiClient.get<PricingPlan[]>('/api/subscription/plans');
};

/**
 * Get current usage statistics
 */
export const getUsage = async (): Promise<UsageLimits> => {
  return apiClient.get<UsageLimits>('/api/subscription/usage');
};

/**
 * Create Stripe Checkout session for upgrade
 */
export const createCheckoutSession = async (
  priceId: string,
  successUrl?: string,
  cancelUrl?: string
): Promise<CheckoutSessionResponse> => {
  // No retries: each attempt creates a Stripe session, and a failing call would
  // otherwise burn through the API rate limit on a single click.
  return apiClient.post<CheckoutSessionResponse>(
    '/api/subscription/checkout',
    { priceId, successUrl, cancelUrl },
    { retries: 0 }
  );
};

/**
 * Create Stripe Billing Portal session
 */
export const createPortalSession = async (): Promise<BillingPortalResponse> => {
  return apiClient.post<BillingPortalResponse>('/api/subscription/portal');
};

/**
 * Cancel subscription at end of billing period
 */
export const cancelSubscription = async (): Promise<void> => {
  await apiClient.post('/api/subscription/cancel');
};

/**
 * Set LLM key preference (Pro users only)
 * @param useOwnKey - true to use own API key, false to use app keys
 */
export const setLLMPreference = async (useOwnKey: boolean): Promise<void> => {
  await apiClient.put('/api/subscription/llm-preference', { useOwnKey });
};
