import Stripe from 'stripe';
import { PrismaClient, SubscriptionStatus } from '@prisma/client';
import { getStripeClient, STRIPE_CONFIG, isStripeConfigured } from '../config/stripe.config';
import {
  SubscriptionDetails,
  UsageLimits,
  PLAN_FEATURES,
  CreateCheckoutRequest,
  CheckoutSessionResponse,
  BillingPortalResponse,
  PricingPlan,
} from '../types/subscription.types';
import { CredentialsService } from './credentials.service';
import { telegramService } from './telegram.instance';
import { referralService } from './referral.instance';
import { logger } from '../utils/logger';

type ResourceType = 'ai' | 'wfirma';

interface ResourceConfig {
  usedField: 'aiMessagesUsed' | 'wfirmaRequestsUsed';
  limitField: 'aiMessagesLimit' | 'wfirmaRequestsLimit';
  resetAtField: 'aiMessagesResetAt' | 'wfirmaRequestsResetAt';
  limitReachedReason: string;
}

const RESOURCE_CONFIGS: Record<ResourceType, ResourceConfig> = {
  ai: {
    usedField: 'aiMessagesUsed',
    limitField: 'aiMessagesLimit',
    resetAtField: 'aiMessagesResetAt',
    limitReachedReason: 'AI_LIMIT_REACHED',
  },
  wfirma: {
    usedField: 'wfirmaRequestsUsed',
    limitField: 'wfirmaRequestsLimit',
    resetAtField: 'wfirmaRequestsResetAt',
    limitReachedReason: 'WFIRMA_LIMIT_REACHED',
  },
};

export class SubscriptionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly credentialsService: CredentialsService
  ) {}

  /**
   * Get subscription details for a user
   */
  async getSubscriptionDetails(userId: string): Promise<SubscriptionDetails> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        subscriptionPlan: true,
        subscriptionStatus: true,
        subscriptionEndDate: true,
        cancelAtPeriodEnd: true,
        useOwnLLMKey: true,
        aiMessagesUsed: true,
        aiMessagesLimit: true,
        aiMessagesResetAt: true,
        wfirmaRequestsUsed: true,
        wfirmaRequestsLimit: true,
        wfirmaRequestsResetAt: true,
      },
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Check if user has their own LLM credentials
    const llmCreds = await this.credentialsService.getLLMCredentials(userId);
    const hasOwnLLMKey = !!llmCreds?.apiKey;

    const features = PLAN_FEATURES[user.subscriptionPlan];

    return {
      plan: user.subscriptionPlan,
      status: user.subscriptionStatus,
      features,
      usage: {
        aiMessages: {
          used: user.aiMessagesUsed,
          limit: user.subscriptionPlan === 'pro' && !user.useOwnLLMKey ? user.aiMessagesLimit : null,
          resetAt: user.aiMessagesResetAt,
        },
        wfirmaRequests: {
          used: user.wfirmaRequestsUsed,
          limit: user.subscriptionPlan === 'free' ? user.wfirmaRequestsLimit : null,
          resetAt: user.wfirmaRequestsResetAt,
        },
      },
      currentPeriodEnd: user.subscriptionEndDate,
      cancelAtPeriodEnd: user.cancelAtPeriodEnd,
      useOwnLLMKey: user.useOwnLLMKey,
      hasOwnLLMKey,
    };
  }

  /**
   * Get available pricing plans
   * Note: Names, descriptions and features are localized on the frontend
   */
  async getPlans(): Promise<PricingPlan[]> {
    return [
      {
        id: 'free',
        priceMonthly: 0,
        priceYearly: 0,
      },
      {
        id: 'pro',
        priceMonthly: 1499, // PLN 14.99
        priceYearly: 14900, // PLN 149.00
        highlighted: true,
      },
    ];
  }

  /**
   * Create Stripe Checkout session for upgrade
   */
  async createCheckoutSession(
    userId: string,
    request: CreateCheckoutRequest
  ): Promise<CheckoutSessionResponse> {
    if (!isStripeConfigured()) {
      throw new Error('Stripe is not configured');
    }

    // Only the API-configured Pro prices may be checked out — the price ID comes
    // from the client, so anything else (e.g. a cheaper price) is rejected.
    const allowedPriceIds = Object.values(STRIPE_CONFIG.prices).filter(Boolean);
    if (allowedPriceIds.length === 0) {
      throw new Error('Stripe prices are not configured');
    }
    if (!allowedPriceIds.includes(request.priceId)) {
      throw new Error('Invalid price ID');
    }

    const stripe = getStripeClient();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, stripeCustomerId: true, referredByCode: true },
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Create or get Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId },
      });
      customerId = customer.id;

      await this.prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });
    }

    // A personal coupon (e.g. a goodwill discount) wins over the referral one —
    // Checkout accepts a single discount and ignores customer-level discounts.
    const customerCoupon = await this.getCustomerCheckoutCoupon(stripe, customerId);
    const coupon =
      customerCoupon ?? (user.referredByCode ? 'first_month_referral' : undefined);
    const discounts = coupon ? [{ coupon }] : undefined;

    // Determine base URL
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3001';

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: request.priceId, quantity: 1 }],
      success_url: request.successUrl || `${baseUrl}${STRIPE_CONFIG.defaultSuccessUrl}`,
      cancel_url: request.cancelUrl || `${baseUrl}${STRIPE_CONFIG.defaultCancelUrl}`,
      metadata: { userId },
      ...(discounts ? { discounts } : {}),
      subscription_data: {
        metadata: { userId },
      },
    });

    if (!session.url) {
      throw new Error('Failed to create checkout session');
    }

    return {
      checkoutUrl: session.url,
      sessionId: session.id,
    };
  }

  /**
   * Coupon set on the Stripe customer as `metadata.checkout_coupon`, if it is
   * still redeemable. Never throws — a bad coupon must not block checkout.
   */
  private async getCustomerCheckoutCoupon(
    stripe: Stripe,
    customerId: string
  ): Promise<string | undefined> {
    try {
      const customer = await stripe.customers.retrieve(customerId);
      const couponId = customer.deleted ? undefined : customer.metadata?.checkout_coupon;
      if (!couponId) return undefined;

      const coupon = await stripe.coupons.retrieve(couponId);
      if (!coupon.valid) {
        logger.warn('Customer checkout coupon is no longer valid', { customerId, couponId });
        return undefined;
      }
      return coupon.id;
    } catch (error) {
      logger.warn('Failed to resolve customer checkout coupon', { customerId, error });
      return undefined;
    }
  }

  /**
   * Create Stripe Billing Portal session
   */
  async createBillingPortalSession(userId: string): Promise<BillingPortalResponse> {
    if (!isStripeConfigured()) {
      throw new Error('Stripe is not configured');
    }

    const stripe = getStripeClient();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { stripeCustomerId: true },
    });

    if (!user?.stripeCustomerId) {
      throw new Error('No Stripe customer found for user');
    }

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3001';

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${baseUrl}/subscription`,
    });

    return { portalUrl: session.url };
  }

  /**
   * Cancel subscription at end of billing period
   */
  async cancelSubscription(userId: string): Promise<void> {
    if (!isStripeConfigured()) {
      throw new Error('Stripe is not configured');
    }

    const stripe = getStripeClient();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { stripeSubscriptionId: true, email: true },
    });

    if (!user?.stripeSubscriptionId) {
      throw new Error('No active subscription found');
    }

    await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: { cancelAtPeriodEnd: true },
    });

    telegramService.notifySubscriptionCanceled(user.email);
  }

  /**
   * Handle Stripe webhook events
   */
  async handleWebhookEvent(event: Stripe.Event): Promise<void> {
    logger.info('[Subscription] Processing webhook event', { type: event.type });

    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await this.handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.deleted':
        await this.handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;

      case 'invoice.paid':
        await this.handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;

      case 'invoice.payment_failed':
        await this.handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      default:
        logger.debug('[Subscription] Unhandled webhook event', { type: event.type });
    }
  }

  private async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const userId = session.metadata?.userId;
    if (!userId) {
      logger.error('[Subscription] No userId in checkout session metadata');
      return;
    }

    logger.info('[Subscription] Checkout completed', { userId, sessionId: session.id });

    // Retrieve the subscription from the session
    if (session.subscription && typeof session.subscription === 'string') {
      const stripe = getStripeClient();
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      await this.syncSubscription(userId, subscription);
      logger.info('[Subscription] Synced subscription after checkout', { userId, subscriptionId: subscription.id });

      // Trigger referral conversion if applicable
      try {
        await referralService.convertReferral(userId);
      } catch (error) {
        logger.warn('[Subscription] Referral conversion failed', { userId, error });
      }
    } else {
      logger.warn('[Subscription] No subscription ID in checkout session', { userId, sessionId: session.id });
    }
  }

  private async handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    const userId = subscription.metadata?.userId;
    if (!userId) {
      // Try to find user by customer ID
      const user = await this.prisma.user.findFirst({
        where: { stripeCustomerId: subscription.customer as string },
      });
      if (!user) {
        logger.error('[Subscription] Cannot find user for subscription', {
          subscriptionId: subscription.id,
        });
        return;
      }
      await this.syncSubscription(user.id, subscription);
    } else {
      await this.syncSubscription(userId, subscription);
    }
  }

  private async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { stripeSubscriptionId: subscription.id },
          { stripeCustomerId: subscription.customer as string },
        ],
      },
    });

    if (!user) {
      logger.warn('[Subscription] User not found for deleted subscription', {
        subscriptionId: subscription.id,
      });
      return;
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionPlan: 'free',
        subscriptionStatus: 'canceled',
        stripeSubscriptionId: null,
        subscriptionEndDate: null,
        cancelAtPeriodEnd: false,
      },
    });

    telegramService.notifySubscriptionCanceled(user.email);

    // Check if this cancellation should revoke a referral reward
    try {
      await referralService.checkRevocation(user.id);
    } catch (error) {
      logger.warn('[Subscription] Referral revocation check failed', { userId: user.id, error });
    }

    logger.info('[Subscription] Subscription deleted, reverted to free', { userId: user.id });
  }

  private async handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const subscriptionId = invoice.subscription as string;
    if (!subscriptionId) return;

    const user = await this.prisma.user.findFirst({
      where: { stripeSubscriptionId: subscriptionId },
    });

    if (user) {
      // Reset usage limits on successful payment
      await this.resetUsageLimits(user.id);
      logger.info('[Subscription] Invoice paid, usage limits reset', { userId: user.id });
    }
  }

  private async handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const subscriptionId = invoice.subscription as string;
    if (!subscriptionId) return;

    const user = await this.prisma.user.findFirst({
      where: { stripeSubscriptionId: subscriptionId },
    });

    if (user) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { subscriptionStatus: 'past_due' },
      });
      logger.warn('[Subscription] Payment failed', { userId: user.id });
    }
  }

  private async syncSubscription(userId: string, subscription: Stripe.Subscription): Promise<void> {
    const status = this.mapStripeStatus(subscription.status);
    const periodEnd = new Date(subscription.current_period_end * 1000);

    logger.info('[Subscription] Syncing subscription', {
      userId,
      subscriptionId: subscription.id,
      status: subscription.status,
      mappedStatus: status,
      periodEnd,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    });

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        subscriptionPlan: 'pro',
        subscriptionStatus: status,
        stripeSubscriptionId: subscription.id,
        subscriptionEndDate: periodEnd,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      },
    });

    telegramService.notifySubscriptionChanged(user.email, 'pro');

    // Auto-provision default LLM credentials for PRO users
    await this.provisionDefaultLLMCredentials(userId);

    logger.info('[Subscription] Successfully synced subscription to database', {
      userId,
      subscriptionId: subscription.id,
      newPlan: 'pro',
      status,
    });
  }

  /**
   * Provision default LLM credentials for PRO users
   * Called automatically when user upgrades to PRO plan
   */
  private async provisionDefaultLLMCredentials(userId: string): Promise<void> {
    try {
      // Check if user already has LLM credentials
      const existingCreds = await this.credentialsService.getLLMCredentials(userId);

      if (existingCreds?.apiKey) {
        logger.debug('[Subscription] User already has LLM credentials, skipping provisioning', { userId });
        return;
      }

      // Get default provider, key, and model from environment
      const defaultProvider = process.env.DEFAULT_LLM_PROVIDER as 'openai' | 'google';
      const defaultApiKey = process.env.DEFAULT_LLM_API_KEY;
      const defaultModel = process.env.DEFAULT_LLM_MODEL;

      if (!defaultProvider || !defaultApiKey) {
        logger.warn('[Subscription] DEFAULT_LLM_PROVIDER or DEFAULT_LLM_API_KEY not configured, skipping auto-provisioning', { userId });
        return;
      }

      // Validate provider
      if (!['openai', 'google'].includes(defaultProvider)) {
        logger.error('[Subscription] Invalid DEFAULT_LLM_PROVIDER value', { provider: defaultProvider, userId });
        return;
      }

      // Save default credentials to user's database record
      await this.credentialsService.setLLMCredentials(userId, {
        provider: defaultProvider,
        apiKey: defaultApiKey,
        model: defaultModel,
      });

      logger.info('[Subscription] Auto-provisioned default LLM credentials for PRO user', {
        userId,
        provider: defaultProvider
      });
    } catch (error) {
      logger.error('[Subscription] Failed to provision default LLM credentials', {
        userId,
        error: (error as Error).message
      });
      // Don't throw - subscription sync should succeed even if credential provisioning fails
    }
  }

  private mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
    switch (status) {
      case 'active':
        return 'active';
      case 'past_due':
        return 'past_due';
      case 'canceled':
        return 'canceled';
      case 'trialing':
        return 'trialing';
      default:
        return 'active';
    }
  }

  /**
   * Check if user can send AI message
   */
  async canSendAIMessage(
    userId: string
  ): Promise<{ allowed: boolean; reason?: string; usage?: UsageLimits['aiMessages'] }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        role: true,
        subscriptionPlan: true,
        useOwnLLMKey: true,
        aiMessagesUsed: true,
        aiMessagesLimit: true,
        aiMessagesResetAt: true,
      },
    });

    if (!user) return { allowed: false, reason: 'User not found' };
    if (user.role === 'admin') return { allowed: true };

    if (user.subscriptionPlan === 'free') {
      const creds = await this.credentialsService.getLLMCredentials(userId);
      if (!creds?.apiKey) return { allowed: false, reason: 'LLM_KEY_REQUIRED' };
      return { allowed: true };
    }

    // Pro with own key - unlimited
    if (user.subscriptionPlan === 'pro' && user.useOwnLLMKey) {
      const creds = await this.credentialsService.getLLMCredentials(userId);
      if (creds?.apiKey) return { allowed: true };
      // Fall through to check app key limits
    }

    return this.checkResourceLimitFromData(userId, 'ai', {
      used: user.aiMessagesUsed,
      limit: user.aiMessagesLimit,
      resetAt: user.aiMessagesResetAt,
    });
  }

  /**
   * Check if user can make wFirma request
   */
  async canMakeWFirmaRequest(
    userId: string
  ): Promise<{ allowed: boolean; reason?: string; usage?: UsageLimits['wfirmaRequests'] }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        role: true,
        subscriptionPlan: true,
        wfirmaRequestsUsed: true,
        wfirmaRequestsLimit: true,
        wfirmaRequestsResetAt: true,
      },
    });

    if (!user) return { allowed: false, reason: 'User not found' };
    if (user.role === 'admin') return { allowed: true };
    if (user.subscriptionPlan === 'pro') return { allowed: true };

    return this.checkResourceLimitFromData(userId, 'wfirma', {
      used: user.wfirmaRequestsUsed,
      limit: user.wfirmaRequestsLimit,
      resetAt: user.wfirmaRequestsResetAt,
    });
  }

  /**
   * Increment AI message usage
   */
  async incrementAIUsage(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, subscriptionPlan: true, useOwnLLMKey: true },
    });

    if (!user) return;
    if (user.role === 'admin') return;
    if (user.subscriptionPlan === 'free') return;
    if (user.subscriptionPlan === 'pro' && user.useOwnLLMKey) {
      const creds = await this.credentialsService.getLLMCredentials(userId);
      if (creds?.apiKey) return;
    }

    await this.incrementUsage(userId, 'ai');
  }

  /**
   * Increment wFirma request usage
   */
  async incrementWFirmaUsage(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, subscriptionPlan: true },
    });

    if (!user) return;
    if (user.role === 'admin') return;
    if (user.subscriptionPlan === 'pro') return;

    await this.incrementUsage(userId, 'wfirma');
  }

  private async checkResourceLimitFromData(
    userId: string,
    resource: ResourceType,
    data: { used: number; limit: number; resetAt: Date | null }
  ): Promise<{ allowed: boolean; reason?: string; usage?: { used: number; limit: number; resetAt: Date | null } }> {
    const cfg = RESOURCE_CONFIGS[resource];
    const { limit } = data;
    let { used, resetAt } = data;

    const now = new Date();
    if (!resetAt || resetAt < now) {
      const nextReset = new Date();
      nextReset.setMonth(nextReset.getMonth() + 1);
      nextReset.setDate(1);
      nextReset.setHours(0, 0, 0, 0);

      await this.prisma.user.update({
        where: { id: userId },
        data: resource === 'ai'
          ? { aiMessagesUsed: 0, aiMessagesResetAt: nextReset }
          : { wfirmaRequestsUsed: 0, wfirmaRequestsResetAt: nextReset },
      });

      logger.debug(`[Subscription] Reset ${resource} limits for user`, { userId, nextReset });
      used = 0;
      resetAt = nextReset;
    }

    const usage = { used, limit, resetAt };
    if (used >= limit) return { allowed: false, reason: cfg.limitReachedReason, usage };
    return { allowed: true, usage };
  }

  private async incrementUsage(userId: string, resource: ResourceType): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: resource === 'ai'
        ? { aiMessagesUsed: { increment: 1 } }
        : { wfirmaRequestsUsed: { increment: 1 } },
    });
  }

  /**
   * Reset all usage limits for a user
   */
  async resetUsageLimits(userId: string): Promise<void> {
    const nextReset = new Date();
    nextReset.setMonth(nextReset.getMonth() + 1);
    nextReset.setDate(1);
    nextReset.setHours(0, 0, 0, 0);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        aiMessagesUsed: 0,
        aiMessagesResetAt: nextReset,
        wfirmaRequestsUsed: 0,
        wfirmaRequestsResetAt: nextReset,
      },
    });
  }

  /**
   * Toggle use of own LLM key for Pro users
   */
  async setUseOwnLLMKey(userId: string, useOwn: boolean): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { subscriptionPlan: true },
    });

    if (!user || user.subscriptionPlan !== 'pro') {
      throw new Error('Only Pro users can toggle LLM key preference');
    }

    if (useOwn) {
      // Verify user has own key
      const creds = await this.credentialsService.getLLMCredentials(userId);
      if (!creds?.apiKey) {
        throw new Error('No LLM API key configured');
      }
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { useOwnLLMKey: useOwn },
    });
  }
}
