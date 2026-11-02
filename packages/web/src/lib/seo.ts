/**
 * Centralised SEO configuration and JSON-LD structured-data builders.
 *
 * i18n strategy (localePrefix: as-needed): Polish is the default and canonical
 * language served on unprefixed URLs (e.g. /pricing). English and Russian are
 * served on prefixed URLs (/en/pricing, /ru/pricing) via middleware rewrite, and
 * every public page advertises the full hreflang trio so all three are indexable.
 */

import { MICODE_SAME_AS, micodeLink } from './external-links';

export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || 'https://eksiegowyai.pl'
).replace(/\/$/, '');

export const SITE_NAME = 'eKsięgowy AI';

// ============================================
// Locale routing (as-needed prefixing)
// ============================================

export type Locale = 'pl' | 'en' | 'ru';

/** All supported locales. Polish is the default (unprefixed). */
export const LOCALES: Locale[] = ['pl', 'en', 'ru'];

/** The default locale, served on unprefixed URLs and used as x-default. */
export const DEFAULT_LOCALE: Locale = 'pl';

/** Locales that carry a URL prefix (everything except the default). */
export const PREFIXED_LOCALES: Locale[] = ['en', 'ru'];

/** BCP-47 tags for hreflang / og:locale, keyed by our short locale codes. */
export const LOCALE_BCP47: Record<Locale, string> = {
  pl: 'pl-PL',
  en: 'en-US',
  ru: 'ru-RU',
};

function isLocale(value: string): value is Locale {
  return (LOCALES as string[]).includes(value);
}

/**
 * Build the locale-aware path for a canonical (unprefixed) path.
 * Polish stays unprefixed; en/ru get a `/en` or `/ru` prefix.
 *   localizedPath('/pricing', 'en') -> '/en/pricing'
 *   localizedPath('/', 'ru')        -> '/ru'
 *   localizedPath('/pricing', 'pl') -> '/pricing'
 */
export function localizedPath(path: string, locale: Locale): string {
  const clean = path === '/' ? '' : path.replace(/\/$/, '');
  if (locale === DEFAULT_LOCALE) return clean || '/';
  return `/${locale}${clean}`;
}

/**
 * Strip a leading locale prefix from a pathname, returning the canonical
 * (unprefixed) path plus the detected locale.
 *   splitLocale('/en/pricing') -> { locale: 'en', path: '/pricing' }
 *   splitLocale('/pricing')    -> { locale: 'pl', path: '/pricing' }
 */
export function splitLocale(pathname: string): { locale: Locale; path: string } {
  const segments = pathname.split('/');
  const maybe = segments[1];
  if (maybe && isLocale(maybe) && maybe !== DEFAULT_LOCALE) {
    const path = '/' + segments.slice(2).join('/');
    return { locale: maybe, path: path === '/' ? '/' : path.replace(/\/$/, '') };
  }
  return { locale: DEFAULT_LOCALE, path: pathname === '/' ? '/' : pathname.replace(/\/$/, '') };
}

/**
 * hreflang alternates for a canonical path, ready to drop into a Metadata
 * `alternates` block. Includes a self-referencing canonical for the given
 * locale plus the full pl/en/ru + x-default language map.
 */
export function alternatesFor(path: string, locale: Locale) {
  const languages: Record<string, string> = {};
  for (const l of LOCALES) {
    languages[LOCALE_BCP47[l]] = localizedPath(path, l);
  }
  languages['x-default'] = localizedPath(path, DEFAULT_LOCALE);
  return {
    canonical: localizedPath(path, locale),
    languages,
  };
}

/** Routes that must never be indexed (auth-gated or API). Used by robots.ts. */
export const PRIVATE_PATHS = [
  '/api/',
  '/admin/',
  '/dashboard/',
  '/chat',
  '/settings/',
  '/subscription/',
  '/ksef/',
  '/referral',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/auth/',
];

/** Public, indexable routes. Used by sitemap.ts. */
export const PUBLIC_PATHS = [
  '/',
  '/pricing',
  '/products',
  '/blog',
  '/guide',
  '/guide/ksef',
  '/guide/ksef/get-tokens',
  '/guide/wfirma',
  '/guide/wfirma/get-api-credentials',
  '/guide/telegram',
  '/guide/telegram/setup',
  '/guide/ai-budget',
  '/guide/ai-budget/connect',
  '/terms',
  '/privacy-policy',
  '/cookies',
  '/rodo',
];

/** Absolute URL for a given path. */
export function absoluteUrl(path: string): string {
  return path === '/' ? SITE_URL : `${SITE_URL}${path}`;
}

// ============================================
// Per-page localized metadata builder
// ============================================

/** Localized copy for a single public page, keyed by locale. */
export interface PageMeta {
  title: string;
  description: string;
  /** Optional OG title override; falls back to `${title} | ${SITE_NAME}`. */
  ogTitle?: string;
  /** Optional OG description override; falls back to `description`. */
  ogDescription?: string;
}

/**
 * Build a locale-correct Metadata fragment for a public subpage.
 *
 * Given the page's per-locale copy and the canonical (unprefixed) path, this
 * sets the right title/description for the active locale, a self-referencing
 * canonical plus the full hreflang trio (+ x-default), and a localized
 * openGraph block whose `url` points at the locale-prefixed page.
 *
 *   export async function generateMetadata(): Promise<Metadata> {
 *     const locale = await getRequestLocale();
 *     return buildPageMetadata(PRICING_META, '/pricing', locale);
 *   }
 */
export function buildPageMetadata(
  meta: Record<Locale, PageMeta>,
  path: string,
  locale: Locale,
) {
  const m = meta[locale];
  const ogTitle = m.ogTitle ?? `${m.title} | ${SITE_NAME}`;
  const ogDescription = m.ogDescription ?? m.description;
  return {
    title: m.title,
    description: m.description,
    alternates: alternatesFor(path, locale),
    openGraph: {
      title: ogTitle,
      description: ogDescription,
      url: localizedPath(path, locale),
    },
  };
}

// ============================================
// Organization (legal entity behind the service)
// ============================================

export const ORGANIZATION_JSONLD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'MICODE sp. z o.o.',
  legalName: 'MICODE SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ',
  url: SITE_URL,
  logo: `${SITE_URL}/logo.svg`,
  // Our other web properties, so search engines resolve them to one entity.
  sameAs: [...MICODE_SAME_AS],
  taxID: '5833510147',
  vatID: 'PL5833510147',
  address: {
    '@type': 'PostalAddress',
    streetAddress: 'ul. Jana Heweliusza 11/811',
    postalCode: '80-890',
    addressLocality: 'Gdańsk',
    addressCountry: 'PL',
  },
};

// ============================================
// ItemList of MICODE products (/products)
// ============================================

/**
 * The catalogue behind /products: this site plus our other properties, in the
 * order the page renders them. Names stay untranslated brand names.
 */
export const PRODUCTS_ITEMLIST_JSONLD = {
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  name: 'MICODE products',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: SITE_NAME, url: SITE_URL },
    { '@type': 'ListItem', position: 2, name: micodeLink('micode').name, url: micodeLink('micode').url },
    {
      '@type': 'ListItem',
      position: 3,
      name: micodeLink('aiBudget').name,
      url: micodeLink('aiBudget').url,
    },
  ],
};

// ============================================
// WebSite (enables sitelinks search box)
// ============================================

export const WEBSITE_JSONLD = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: SITE_NAME,
  url: SITE_URL,
  inLanguage: 'pl-PL',
  publisher: { '@type': 'Organization', name: 'MICODE sp. z o.o.' },
};

// ============================================
// SoftwareApplication (the product itself)
// ============================================

export const SOFTWARE_APPLICATION_JSONLD = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: SITE_NAME,
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web',
  url: SITE_URL,
  description:
    'Asystent księgowy oparty na AI dla polskich firm. Integracja z wFirma, obsługa e-faktur KSeF oraz odpowiedzi na pytania o VAT, PIT, CIT i ZUS.',
  inLanguage: ['pl-PL', 'en-US', 'ru-RU'],
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'PLN',
  },
  publisher: { '@type': 'Organization', name: 'MICODE sp. z o.o.' },
};

/**
 * HowTo structured data for a step-by-step guide. Generative engines and rich
 * results surface procedural content from this — each step becomes a HowToStep.
 */
export function howToJsonLd(input: {
  name: string;
  description?: string;
  steps: { name: string; text: string }[];
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    step: input.steps.map((s, index) => ({
      '@type': 'HowToStep',
      position: index + 1,
      name: s.name,
      text: s.text,
    })),
  };
}

/** Build a BreadcrumbList for a guide page. */
export function breadcrumbJsonLd(items: Array<{ name: string; path: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

// ============================================
// Blog helpers (per-post hreflang + JSON-LD)
// ============================================

/**
 * The named person behind the articles (E-E-A-T: a real human author, not just
 * the organization). Used for both the visible byline and the BlogPosting
 * `author`. Add `url` (LinkedIn / personal / author page) to emit `sameAs` — the
 * strongest authorship signal for AI answer engines and search — and `jobTitle`
 * for the person's role.
 */
export const ARTICLE_AUTHOR: {
  name: string;
  url?: string;
  sameAs?: string[];
  jobTitle?: string;
} = {
  name: 'Mikhail Peraviortkin',
  url: 'http://mi-code.pl',
  sameAs: ['http://mi-code.pl', 'https://www.linkedin.com/in/mikhailperaviortkin/'],
};

/** The LinkedIn profile URL within a `sameAs` list, if any — for a visible
 *  byline link that corroborates the JSON-LD `sameAs` (stronger E-E-A-T). */
export function findLinkedIn(sameAs: string[] | undefined): string | undefined {
  return sameAs?.find((u) => /linkedin\.com/i.test(u));
}

/**
 * hreflang alternates for a blog article, built ONLY from the locales that
 * actually have a published translation. `x-default` points at the Polish
 * variant if present, otherwise the active locale.
 */
export function blogAlternatesFor(
  translations: { locale: Locale; slug: string }[],
  activeLocale: Locale,
) {
  const slugFor = (locale: Locale) => translations.find((t) => t.locale === locale)?.slug;
  const languages: Record<string, string> = {};
  for (const t of translations) {
    languages[LOCALE_BCP47[t.locale]] = localizedPath(`/blog/${t.slug}`, t.locale);
  }
  const defaultSlug = slugFor(DEFAULT_LOCALE);
  if (defaultSlug) languages['x-default'] = localizedPath(`/blog/${defaultSlug}`, DEFAULT_LOCALE);
  const activeSlug = slugFor(activeLocale) ?? translations[0]?.slug ?? '';
  return { canonical: localizedPath(`/blog/${activeSlug}`, activeLocale), languages };
}

/** BlogPosting structured data for an article page. */
export function blogPostingJsonLd(input: {
  title: string;
  description: string;
  slug: string;
  locale: Locale;
  publishedAt: string | null;
  updatedAt: string | null;
  author: string;
  /** Author homepage → Person `url`. */
  authorUrl?: string;
  /** Author's authoritative profiles → Person `sameAs` (strongest E-E-A-T signal). */
  authorSameAs?: string[];
  /** Author role → Person `jobTitle`. */
  authorJobTitle?: string;
  coverImage?: string | null;
  /** Article tags → schema `keywords` (topical signal for AI/search engines). */
  keywords?: string[];
  /** Article category → schema `articleSection`. */
  section?: string;
  /** Approximate body word count → schema `wordCount` (quality/depth signal). */
  wordCount?: number;
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: input.title,
    description: input.description,
    inLanguage: LOCALE_BCP47[input.locale],
    datePublished: input.publishedAt ?? undefined,
    dateModified: input.updatedAt ?? input.publishedAt ?? undefined,
    // A named Person author (not the org) is a stronger authorship/E-E-A-T
    // signal for AI answer engines and search; the org remains the publisher.
    author: {
      '@type': 'Person',
      name: input.author,
      ...(input.authorUrl ? { url: input.authorUrl } : {}),
      ...(input.authorSameAs && input.authorSameAs.length > 0
        ? { sameAs: input.authorSameAs }
        : {}),
      ...(input.authorJobTitle ? { jobTitle: input.authorJobTitle } : {}),
    },
    publisher: { '@type': 'Organization', name: 'MICODE sp. z o.o.' },
    mainEntityOfPage: absoluteUrl(localizedPath(`/blog/${input.slug}`, input.locale)),
    image: input.coverImage || undefined,
    ...(input.keywords && input.keywords.length > 0
      ? { keywords: input.keywords.join(', ') }
      : {}),
    ...(input.section ? { articleSection: input.section } : {}),
    ...(input.wordCount && input.wordCount > 0 ? { wordCount: input.wordCount } : {}),
  };
}

/** FAQPage structured data from an article's FAQ list. */
export function faqPageJsonLd(faq: { q: string; a: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
}

// ============================================
// llms.txt (AI / LLM crawler guidance — llmstxt.org)
// ============================================

/** One article entry for the llms.txt "Articles" section. */
export interface LlmsArticle {
  title: string;
  slug: string;
  description: string;
}

/**
 * Build the `/llms.txt` document: a concise, link-first Markdown overview that
 * generative engines (ChatGPT, Perplexity, Gemini, Claude, AI Overviews) read
 * to understand the site and find its most useful pages. Follows the
 * llmstxt.org convention — H1 name, `>` summary, then `##` sections of links.
 *
 * Links point at the canonical (Polish) URLs; the English/Russian variants live
 * under `/en` and `/ru`. `articles` is expected newest-first.
 */
export function buildLlmsTxt(articles: LlmsArticle[]): string {
  const link = (label: string, path: string, desc?: string) =>
    `- [${label}](${absoluteUrl(path)})${desc ? `: ${desc}` : ''}`;

  const lines: string[] = [
    `# ${SITE_NAME}`,
    '',
    '> AI-powered accounting assistant for Polish businesses — integrates with wFirma, ' +
      'handles KSeF e-invoices, and answers VAT, PIT, CIT and ZUS questions in plain language.',
    '',
    `${SITE_NAME} (${SITE_URL}) is a product of MICODE sp. z o.o. It is available in Polish ` +
      '(default, canonical), English (/en) and Russian (/ru). The links below point to the ' +
      'canonical Polish URLs.',
    '',
    '## Product',
    '',
    `- [Home](${SITE_URL}): What ${SITE_NAME} is, its features and who it is for.`,
    link('Pricing', '/pricing', 'Plans, including a free tier when you bring your own OpenAI key.'),
    link('Blog', '/blog', 'Explainers and how-tos on Polish accounting, taxes and KSeF.'),
    '',
    '## Guides',
    '',
    link('KSeF setup', '/guide/ksef', "Connect and send e-invoices through Poland's National e-Invoice System (KSeF)."),
    link('wFirma integration', '/guide/wfirma', 'Link your wFirma account and API credentials.'),
    link('Telegram bot', '/guide/telegram', 'Book expenses from receipt photos via Telegram OCR.'),
    link('AI Budget integration', '/guide/ai-budget', 'Connect AI Budget Assistant, choose your company account and reconcile expenses with wFirma.'),
    '',
    '## Articles',
    '',
    ...articles.map((a) => link(a.title, `/blog/${a.slug}`, a.description)),
    '',
    '## Company',
    '',
    link('Terms of Service', '/terms'),
    link('Privacy Policy', '/privacy-policy'),
    link('RODO / GDPR', '/rodo'),
    '',
  ];

  return lines.join('\n');
}
