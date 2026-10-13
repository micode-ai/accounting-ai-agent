/**
 * SubscriptionService.createCheckoutSession — price allow-list
 *
 * The client sends a Stripe price ID; only the API-configured Pro prices may
 * reach Stripe, otherwise a user could check out with any active price in the
 * account.
 */

jest.mock('../telegram.instance', () => ({ telegramService: {} }));
jest.mock('../referral.instance', () => ({ referralService: {} }));

const sessionsCreate = jest.fn();
jest.mock('../../config/stripe.config', () => ({
  isStripeConfigured: () => true,
  getStripeClient: () => ({
    customers: { create: jest.fn() },
    checkout: { sessions: { create: sessionsCreate } },
  }),
  STRIPE_CONFIG: {
    prices: { proMonthly: 'price_monthly', proYearly: 'price_yearly' },
    defaultSuccessUrl: '/subscription/success',
    defaultCancelUrl: '/subscription/cancel',
  },
}));

import { SubscriptionService } from '../subscription.service';
import { STRIPE_CONFIG } from '../../config/stripe.config';

function makeService() {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        email: 'user@example.com',
        stripeCustomerId: 'cus_1',
        referredByCode: null,
      }),
      update: jest.fn(),
    },
  };
  return new SubscriptionService(prisma as any, {} as any);
}

describe('SubscriptionService.createCheckoutSession price allow-list', () => {
  beforeEach(() => {
    sessionsCreate.mockReset();
    sessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/x' });
    STRIPE_CONFIG.prices.proMonthly = 'price_monthly';
    STRIPE_CONFIG.prices.proYearly = 'price_yearly';
  });

  it.each(['price_monthly', 'price_yearly'])('accepts configured price %s', async (priceId) => {
    const result = await makeService().createCheckoutSession('u1', { priceId });

    expect(result.checkoutUrl).toBe('https://checkout.stripe.com/x');
    expect(sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ line_items: [{ price: priceId, quantity: 1 }] })
    );
  });

  it('rejects a price that is not configured, without calling Stripe', async () => {
    await expect(
      makeService().createCheckoutSession('u1', { priceId: 'price_someone_else' })
    ).rejects.toThrow('Invalid price');
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('reports "not configured" when the API has no Pro prices set', async () => {
    STRIPE_CONFIG.prices.proMonthly = '';
    STRIPE_CONFIG.prices.proYearly = '';

    await expect(
      makeService().createCheckoutSession('u1', { priceId: 'price_monthly' })
    ).rejects.toThrow('not configured');
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});
