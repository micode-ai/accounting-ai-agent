/**
 * SubscriptionService.createCheckoutSession — price allow-list
 *
 * The client sends a Stripe price ID; only the API-configured Pro prices may
 * reach Stripe, otherwise a user could check out with any active price in the
 * account. A per-customer coupon (customer.metadata.checkout_coupon) is
 * applied when still valid, since Checkout ignores customer-level discounts.
 */

jest.mock('../telegram.instance', () => ({ telegramService: {} }));
jest.mock('../referral.instance', () => ({ referralService: {} }));

const sessionsCreate = jest.fn();
const customersRetrieve = jest.fn();
const couponsRetrieve = jest.fn();
jest.mock('../../config/stripe.config', () => ({
  isStripeConfigured: () => true,
  getStripeClient: () => ({
    customers: { create: jest.fn(), retrieve: customersRetrieve },
    coupons: { retrieve: couponsRetrieve },
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

function makeService(referredByCode: string | null = null) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        email: 'user@example.com',
        stripeCustomerId: 'cus_1',
        referredByCode,
      }),
      update: jest.fn(),
    },
  };
  return new SubscriptionService(prisma as any, {} as any);
}

describe('SubscriptionService.createCheckoutSession price allow-list', () => {
  beforeEach(() => {
    customersRetrieve.mockResolvedValue({ id: 'cus_1', metadata: {} });
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

describe('SubscriptionService.createCheckoutSession per-customer coupon', () => {
  beforeEach(() => {
    sessionsCreate.mockReset();
    sessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/x' });
    couponsRetrieve.mockReset();
    STRIPE_CONFIG.prices.proMonthly = 'price_monthly';
    STRIPE_CONFIG.prices.proYearly = 'price_yearly';
  });

  const discountsSent = () => sessionsCreate.mock.calls[0][0].discounts;

  it('applies a valid coupon from customer metadata', async () => {
    customersRetrieve.mockResolvedValue({ id: 'cus_1', metadata: { checkout_coupon: 'free_month' } });
    couponsRetrieve.mockResolvedValue({ id: 'free_month', valid: true });

    await makeService().createCheckoutSession('u1', { priceId: 'price_monthly' });

    expect(discountsSent()).toEqual([{ coupon: 'free_month' }]);
  });

  it('prefers the customer coupon over the referral coupon', async () => {
    customersRetrieve.mockResolvedValue({ id: 'cus_1', metadata: { checkout_coupon: 'free_month' } });
    couponsRetrieve.mockResolvedValue({ id: 'free_month', valid: true });

    await makeService('REF12345').createCheckoutSession('u1', { priceId: 'price_monthly' });

    expect(discountsSent()).toEqual([{ coupon: 'free_month' }]);
  });

  it('falls back to the referral coupon when the customer coupon is used up', async () => {
    customersRetrieve.mockResolvedValue({ id: 'cus_1', metadata: { checkout_coupon: 'free_month' } });
    couponsRetrieve.mockResolvedValue({ id: 'free_month', valid: false });

    await makeService('REF12345').createCheckoutSession('u1', { priceId: 'price_monthly' });

    expect(discountsSent()).toEqual([{ coupon: 'first_month_referral' }]);
  });

  it('ignores a coupon that cannot be retrieved instead of failing checkout', async () => {
    customersRetrieve.mockResolvedValue({ id: 'cus_1', metadata: { checkout_coupon: 'gone' } });
    couponsRetrieve.mockRejectedValue(new Error('No such coupon'));

    await makeService().createCheckoutSession('u1', { priceId: 'price_monthly' });

    expect(discountsSent()).toBeUndefined();
  });

  it('sends no discount when the customer has no coupon', async () => {
    customersRetrieve.mockResolvedValue({ id: 'cus_1', metadata: {} });

    await makeService().createCheckoutSession('u1', { priceId: 'price_monthly' });

    expect(discountsSent()).toBeUndefined();
    expect(couponsRetrieve).not.toHaveBeenCalled();
  });
});
