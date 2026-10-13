'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSubscription } from '@/hooks/useSubscription';
import { useLocale } from '@/contexts/LocaleContext';
import { Check, Loader2, Zap, Crown } from 'lucide-react';
import Link from 'next/link';
import enTranslations from '@/i18n/locales/en.json';
import plTranslations from '@/i18n/locales/pl.json';
import ruTranslations from '@/i18n/locales/ru.json';

const translations = {
  en: enTranslations,
  pl: plTranslations,
  ru: ruTranslations,
};

type BillingInterval = 'monthly' | 'yearly';

interface PricingPlansProps {
  showHeader?: boolean;
  isPublic?: boolean;
}

export function PricingPlans({ showHeader = true, isPublic = false }: PricingPlansProps) {
  const { locale } = useLocale();
  const t = translations[locale].subscription;
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('monthly');
  const { subscription, plans, isLoading, isCheckingOut, checkout, checkoutError, isPro } =
    useSubscription({
      skipSubscription: isPublic,
    });
  const searchParams = useSearchParams();

  // Get Pro plan data
  const proPlan = plans?.find((p) => p.id === 'pro');

  // Get price based on interval
  const getProPrice = () => {
    if (!proPlan) return 0;
    return billingInterval === 'yearly' ? proPlan.priceYearly : proPlan.priceMonthly;
  };

  // Get price ID based on interval
  const getProPriceId = () => {
    // These should match your Stripe Price IDs from environment
    return billingInterval === 'yearly'
      ? process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_YEARLY
      : process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_MONTHLY;
  };

  const handleUpgrade = () => {
    const priceId = getProPriceId();
    if (priceId) {
      checkout(priceId);
    }
  };

  // Read billing period from URL (for auto-checkout from registration)
  useEffect(() => {
    const urlBillingPeriod = searchParams.get('billingPeriod');
    if (urlBillingPeriod === 'yearly' || urlBillingPeriod === 'monthly') {
      setBillingInterval(urlBillingPeriod);
    }
  }, [searchParams]);

  // Auto-checkout if coming from registration (skip for public pages)
  useEffect(() => {
    if (isPublic) return;
    const autoCheckout = searchParams.get('autoCheckout');
    if (autoCheckout === 'true' && !isPro && !isCheckingOut && !isLoading) {
      // Small delay to ensure everything is loaded
      const timer = setTimeout(() => {
        handleUpgrade();
      }, 500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [searchParams, isPro, isCheckingOut, isLoading, billingInterval, handleUpgrade, isPublic]);

  // Format price for display
  const formatPrice = (cents: number) => {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'PLN',
      minimumFractionDigits: 0,
    }).format(cents / 100);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="py-12 px-4 sm:px-6 lg:px-8">
      {showHeader && (
        <div className="text-center mb-12">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">
            {t?.title}
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
            {t?.subtitle}
          </p>
        </div>
      )}

      {/* Billing Toggle */}
      <div className="flex justify-center mb-8">
        <div className="bg-gray-100 dark:bg-gray-800 p-1 rounded-lg inline-flex">
          <button
            onClick={() => setBillingInterval('monthly')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              billingInterval === 'monthly'
                ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
            }`}
          >
            {t?.monthly || 'Monthly'}
          </button>
          <button
            onClick={() => setBillingInterval('yearly')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              billingInterval === 'yearly'
                ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
            }`}
          >
            {t?.yearly || 'Yearly'}
            <span className="ml-1 text-green-600 text-xs">
              {t?.savePercent}
            </span>
          </button>
        </div>
      </div>

      {/* Plans Grid */}
      <div className="max-w-5xl mx-auto grid md:grid-cols-2 gap-8">
        {/* Free Plan */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-200 dark:border-gray-700 p-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-gray-100 dark:bg-gray-700 rounded-lg flex items-center justify-center">
              <Zap className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            </div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">
              {t?.plans?.free?.name}
            </h2>
          </div>

          <p className="text-gray-600 dark:text-gray-400 mb-6">
            {t?.plans?.free?.description}
          </p>

          <div className="mb-6">
            <span className="text-4xl font-bold text-gray-900 dark:text-white">PLN0</span>
            <span className="text-gray-600 dark:text-gray-400">/{t?.perMonth || 'month'}</span>
          </div>

          {isPublic ? (
            <Link
              href="/register"
              className="block w-full py-3 px-4 bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white text-center rounded-lg font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              {t?.registerForFree || 'Sign up free'}
            </Link>
          ) : subscription?.plan === 'free' ? (
            <div className="w-full py-3 px-4 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 text-center rounded-lg font-medium">
              {t?.currentPlan}
            </div>
          ) : (
            <Link
              href="/chat"
              className="block w-full py-3 px-4 bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white text-center rounded-lg font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              {t?.getStarted}
            </Link>
          )}

          <ul className="mt-8 space-y-4">
            <PlanFeature text={t?.features?.byok} />
            <PlanFeature text={t?.features?.unlimitedWithKey} />
            <PlanFeature text={t?.features?.wfirmaLimited} />
            <PlanFeature text={t?.features?.basicSupport} />
          </ul>
        </div>

        {/* Pro Plan */}
        <div className="bg-gradient-to-b from-blue-50 to-white dark:from-blue-900/20 dark:to-gray-800 rounded-2xl shadow-lg border-2 border-blue-500 p-8 relative">
          <div className="absolute -top-3 left-1/2 -translate-x-1/2">
            <span className="bg-blue-600 text-white text-xs font-bold px-3 py-1 rounded-full">
              {t?.popular}
            </span>
          </div>

          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/50 rounded-lg flex items-center justify-center">
              <Crown className="w-5 h-5 text-blue-600" />
            </div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">
              {t?.plans?.pro?.name}
            </h2>
          </div>

          <p className="text-gray-600 dark:text-gray-400 mb-6">
            {t?.plans?.pro?.description}
          </p>

          <div className="mb-6">
            <span className="text-4xl font-bold text-gray-900 dark:text-white">
              {billingInterval === 'yearly'
                ? formatPrice(getProPrice() / 12)
                : formatPrice(getProPrice())}
            </span>
            <span className="text-gray-600 dark:text-gray-400">/{t?.perMonth || 'month'}</span>
            {billingInterval === 'yearly' && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {t?.billedYearly} ({formatPrice(getProPrice())})
              </p>
            )}
          </div>

          {isPublic ? (
            <Link
              href="/register?plan=pro"
              className="block w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white text-center rounded-lg font-medium transition-colors"
            >
              {t?.registerToPurchase || 'Sign up to get started'}
            </Link>
          ) : isPro ? (
            <div className="w-full py-3 px-4 bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 text-center rounded-lg font-medium">
              {t?.currentPlan}
            </div>
          ) : (
            <button
              onClick={handleUpgrade}
              disabled={isCheckingOut || !getProPriceId()}
              className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white text-center rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isCheckingOut ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t?.processing}
                </>
              ) : (
                t?.upgradeToPro
              )}
            </button>
          )}

          {checkoutError && !isCheckingOut && (
            <p role="alert" className="mt-3 text-sm text-center text-red-600 dark:text-red-400">
              {t?.checkoutError}
            </p>
          )}

          <ul className="mt-8 space-y-4">
            <PlanFeature text={t?.features?.includedCredits} highlighted />
            <PlanFeature text={t?.features?.orOwnKey} />
            <PlanFeature text={t?.features?.wfirmaUnlimited} highlighted />
            <PlanFeature text={t?.features?.prioritySupport} highlighted />
          </ul>
        </div>
      </div>

      {/* FAQ or Additional Info */}
      <div className="max-w-3xl mx-auto mt-16 text-center">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          {t?.faq?.title}
        </h3>
        <p className="text-gray-600 dark:text-gray-400">
          {t?.faq?.description}
        </p>
      </div>
    </div>
  );
}

function PlanFeature({ text, highlighted = false }: { text: string; highlighted?: boolean }) {
  return (
    <li className="flex items-start gap-3">
      <div
        className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
          highlighted
            ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-600'
            : 'bg-gray-100 dark:bg-gray-700 text-gray-500'
        }`}
      >
        <Check className="w-3 h-3" />
      </div>
      <span className="text-gray-700 dark:text-gray-300">{text}</span>
    </li>
  );
}
