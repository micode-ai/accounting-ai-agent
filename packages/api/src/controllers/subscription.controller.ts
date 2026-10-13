import { Request, Response } from 'express';
import { subscriptionService } from '../services/subscription.instance';
import { logger } from '../utils/logger';
import { CreateCheckoutRequest } from '../types/subscription.types';

export class SubscriptionController {
  /**
   * GET /api/subscription
   * Get current user's subscription details
   */
  async getSubscription(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
        return;
      }

      const subscription = await subscriptionService.getSubscriptionDetails(userId);

      res.status(200).json({
        success: true,
        data: subscription,
      });
    } catch (error) {
      logger.error('Error fetching subscription', { error, userId: req.user?.userId });
      res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to fetch subscription details',
      });
    }
  }

  /**
   * GET /api/subscription/plans
   * Get available subscription plans
   */
  async getPlans(_req: Request, res: Response): Promise<void> {
    try {
      const plans = await subscriptionService.getPlans();

      res.status(200).json({
        success: true,
        data: plans,
      });
    } catch (error) {
      logger.error('Error fetching plans', { error });
      res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to fetch subscription plans',
      });
    }
  }

  /**
   * POST /api/subscription/checkout
   * Create Stripe Checkout session for upgrade
   */
  async createCheckoutSession(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
        return;
      }

      const { priceId, successUrl, cancelUrl } = req.body as CreateCheckoutRequest;

      if (!priceId) {
        res.status(400).json({
          success: false,
          error: 'Validation Error',
          message: 'priceId is required',
        });
        return;
      }

      const session = await subscriptionService.createCheckoutSession(userId, {
        priceId,
        successUrl,
        cancelUrl,
      });

      logger.info('Checkout session created', { userId, sessionId: session.sessionId });

      res.status(200).json({
        success: true,
        data: session,
      });
    } catch (error) {
      const message = (error as Error).message;
      logger.error('Error creating checkout session', { error, userId: req.user?.userId });

      if (message === 'Invalid price ID') {
        res.status(400).json({
          success: false,
          error: 'Validation Error',
          message: 'Invalid price ID',
        });
        return;
      }

      // An archived/inactive price in Stripe is a configuration problem, not a
      // transient failure — surface it as 503 and make it easy to grep for.
      const stripeError = error as { type?: string; param?: string };
      if (
        stripeError.type === 'StripeInvalidRequestError' &&
        stripeError.param?.startsWith('line_items')
      ) {
        logger.error('Stripe price is inactive or invalid — check STRIPE_PRICE_PRO_* in Stripe', {
          priceId: (req.body as CreateCheckoutRequest).priceId,
        });
        res.status(503).json({
          success: false,
          error: 'Service Unavailable',
          message: 'Payment system is not configured',
        });
        return;
      }

      if (message.includes('not configured')) {
        res.status(503).json({
          success: false,
          error: 'Service Unavailable',
          message: 'Payment system is not configured',
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to create checkout session',
      });
    }
  }

  /**
   * POST /api/subscription/portal
   * Create Stripe Billing Portal session
   */
  async createPortalSession(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
        return;
      }

      const portal = await subscriptionService.createBillingPortalSession(userId);

      logger.info('Billing portal session created', { userId });

      res.status(200).json({
        success: true,
        data: portal,
      });
    } catch (error) {
      const message = (error as Error).message;
      logger.error('Error creating portal session', { error, userId: req.user?.userId });

      if (message.includes('No Stripe customer')) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'No subscription found for this account',
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to create billing portal session',
      });
    }
  }

  /**
   * POST /api/subscription/cancel
   * Cancel subscription at end of billing period
   */
  async cancelSubscription(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
        return;
      }

      await subscriptionService.cancelSubscription(userId);

      logger.info('Subscription cancellation requested', { userId });

      res.status(200).json({
        success: true,
        message: 'Subscription will be cancelled at end of billing period',
      });
    } catch (error) {
      const message = (error as Error).message;
      logger.error('Error cancelling subscription', { error, userId: req.user?.userId });

      if (message.includes('No active subscription')) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'No active subscription to cancel',
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to cancel subscription',
      });
    }
  }

  /**
   * GET /api/subscription/usage
   * Get current usage statistics
   */
  async getUsage(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
        return;
      }

      const subscription = await subscriptionService.getSubscriptionDetails(userId);

      res.status(200).json({
        success: true,
        data: subscription.usage,
      });
    } catch (error) {
      logger.error('Error fetching usage', { error, userId: req.user?.userId });
      res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to fetch usage statistics',
      });
    }
  }

  /**
   * PUT /api/subscription/llm-preference
   * Toggle between app keys and own LLM key (Pro only)
   */
  async setLLMPreference(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
        return;
      }

      const { useOwnKey } = req.body;

      if (typeof useOwnKey !== 'boolean') {
        res.status(400).json({
          success: false,
          error: 'Validation Error',
          message: 'useOwnKey must be a boolean',
        });
        return;
      }

      await subscriptionService.setUseOwnLLMKey(userId, useOwnKey);

      logger.info('LLM preference updated', { userId, useOwnKey });

      res.status(200).json({
        success: true,
        message: useOwnKey
          ? 'Now using your own API key (unlimited messages)'
          : 'Now using app API keys (with monthly limit)',
      });
    } catch (error) {
      const message = (error as Error).message;
      logger.error('Error setting LLM preference', { error, userId: req.user?.userId });

      if (message.includes('Only Pro users')) {
        res.status(403).json({
          success: false,
          error: 'Forbidden',
          message: 'This feature is only available for Pro subscribers',
        });
        return;
      }

      if (message.includes('No LLM API key')) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Please add your API key first in credentials settings',
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to update LLM preference',
      });
    }
  }
}

export const subscriptionController = new SubscriptionController();
