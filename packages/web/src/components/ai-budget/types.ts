import en from '@/i18n/locales/en.json';

/** The whole `aiBudget` translation namespace (en shape; pl/ru match it). */
export type AiBudgetT = typeof en.aiBudget;

export const intlLocale = (locale: string): string => (locale === 'pl' ? 'pl-PL' : locale === 'ru' ? 'ru-RU' : 'en-US');

export const formatMoney = (value: number, currency: string, locale: string): string => {
  try {
    return new Intl.NumberFormat(intlLocale(locale), { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
};
