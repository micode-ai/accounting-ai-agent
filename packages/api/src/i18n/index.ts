import plTranslations from './locales/pl.json';
import enTranslations from './locales/en.json';
import ruTranslations from './locales/ru.json';

export type Locale = 'pl' | 'en' | 'ru';

export type Translations = typeof plTranslations;
export type CommonTranslations = typeof plTranslations['common'];
export type OcrTranslations = typeof plTranslations['ocr'];
export type ContractorTranslations = typeof plTranslations['contractor'];
export type InvoiceTranslations = typeof plTranslations['invoice'];
export type CompanyTranslations = typeof plTranslations['company'];
export type UserTranslations = typeof plTranslations['user'];
export type PaymentTranslations = typeof plTranslations['payment'];
export type ExpenseTranslations = typeof plTranslations['expense'];
export type VehicleTranslations = typeof plTranslations['vehicle'];
export type TermTranslations = typeof plTranslations['term'];
export type DeclarationTranslations = typeof plTranslations['declarations'];
export type DocumentTranslations = typeof plTranslations['document'];
export type LedgerTranslations = typeof plTranslations['ledger'];
export type HRTranslations = typeof plTranslations['hr'];
export type KSeFTranslations = typeof plTranslations['ksef'];
export type BialaListaTranslations = typeof plTranslations['bialaLista'];
export type TaxCalendarTranslations = typeof plTranslations['taxCalendar'];
export type TaxRegisterTranslations = typeof plTranslations['taxRegister'];
export type AiBudgetTranslations = typeof plTranslations['aiBudget'];

const translations: Record<Locale, Translations> = {
  pl: plTranslations,
  en: enTranslations,
  ru: ruTranslations,
};

export function getTranslations(locale: Locale = 'pl'): Translations {
  return translations[locale] || translations.pl;
}

export function getContractorTranslations(locale: Locale = 'pl'): ContractorTranslations {
  return getTranslations(locale).contractor;
}

export function getInvoiceTranslations(locale: Locale = 'pl'): InvoiceTranslations {
  return getTranslations(locale).invoice;
}

export function getCompanyTranslations(locale: Locale = 'pl'): CompanyTranslations {
  return getTranslations(locale).company;
}

export function getUserTranslations(locale: Locale = 'pl'): UserTranslations {
  return getTranslations(locale).user;
}

export function getPaymentTranslations(locale: Locale = 'pl'): PaymentTranslations {
  return getTranslations(locale).payment;
}

export function getExpenseTranslations(locale: Locale = 'pl'): ExpenseTranslations {
  return getTranslations(locale).expense;
}

export function getVehicleTranslations(locale: Locale = 'pl'): VehicleTranslations {
  return getTranslations(locale).vehicle;
}

export function getTermTranslations(locale: Locale = 'pl'): TermTranslations {
  return getTranslations(locale).term;
}

export function getDeclarationTranslations(locale: Locale = 'pl'): DeclarationTranslations {
  return getTranslations(locale).declarations;
}

export function getDocumentTranslations(locale: Locale = 'pl'): DocumentTranslations {
  return getTranslations(locale).document;
}

export function getLedgerTranslations(locale: Locale = 'pl'): LedgerTranslations {
  return getTranslations(locale).ledger;
}

export function getHRTranslations(locale: Locale = 'pl'): HRTranslations {
  return getTranslations(locale).hr;
}

export function getKSeFTranslations(locale: Locale = 'pl'): KSeFTranslations {
  return getTranslations(locale).ksef;
}

export function getBialaListaTranslations(locale: Locale = 'pl'): BialaListaTranslations {
  return getTranslations(locale).bialaLista;
}

export function getCommonTranslations(locale: Locale = 'pl'): CommonTranslations {
  return getTranslations(locale).common;
}

export function getOcrTranslations(locale: Locale = 'pl'): OcrTranslations {
  return getTranslations(locale).ocr;
}

export function getTaxCalendarTranslations(locale: Locale = 'pl'): TaxCalendarTranslations {
  return getTranslations(locale).taxCalendar;
}

export function getTaxRegisterTranslations(locale: Locale = 'pl'): TaxRegisterTranslations {
  return getTranslations(locale).taxRegister;
}

export function getAiBudgetTranslations(locale: Locale = 'pl'): AiBudgetTranslations {
  return getTranslations(locale).aiBudget;
}
