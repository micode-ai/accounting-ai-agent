import * as Sentry from '@sentry/node';
import { logger } from '../utils/logger';

/** The AI Budget OAuth routes of this API (the callback URL carries `code` and `state`). */
const AI_BUDGET_ROUTE = '/api/integrations/ai-budget/';

function aiBudgetHosts(): string[] {
  const hosts = ['api.ai-budget.pl'];
  try {
    if (process.env.AI_BUDGET_API_URL) hosts.push(new URL(process.env.AI_BUDGET_API_URL).host);
  } catch {
    // An invalid URL hides the feature anyway (ai-budget.config); nothing to add.
  }
  return hosts;
}

/** True for a URL (absolute or a path) of this API's AI Budget routes or of the AI Budget API itself. */
function isAiBudgetUrl(url: string): boolean {
  if (url.includes(AI_BUDGET_ROUTE)) return true;
  return aiBudgetHosts().some((h) => url.includes(`//${h}/`) || url.includes(`//${h}?`) || url.endsWith(`//${h}`));
}

/** Drops the query string and fragment from every AI Budget URL inside the text (chat search text, cursors, codes). */
function stripAiBudgetQueries(text: string): string {
  return text.replace(/\S+/g, (token) => (isAiBudgetUrl(token) ? token.replace(/[?#].*$/, '') : token));
}

const QUERY_KEYS = ['http.query', 'url.query', 'query', 'http.fragment', 'url.fragment'];

/** Strips AI Budget query strings from a span's or breadcrumb's data in place; returns whether it was an AI Budget URL. */
function scrubData(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  let hit = false;
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' && isAiBudgetUrl(v)) {
      data[k] = stripAiBudgetQueries(v);
      hit = true;
    }
  }
  if (hit) for (const k of QUERY_KEYS) delete data[k];
  return hit;
}

interface ScrubbableEvent {
  request?: { url?: string; query_string?: unknown; headers?: Record<string, unknown> };
  transaction?: string;
  spans?: Array<{ description?: string; data?: Record<string, unknown> }>;
  breadcrumbs?: Sentry.Breadcrumb[];
}

/** Removes secrets and AI Budget query strings from an error or transaction event (in place). */
export function scrubAiBudgetEvent<E>(event: E): E {
  const ev = event as unknown as ScrubbableEvent;
  if (ev.request) {
    if (ev.request.headers) {
      delete ev.request.headers['authorization'];
      delete ev.request.headers['cookie'];
    }
    if (typeof ev.request.url === 'string' && isAiBudgetUrl(ev.request.url)) {
      ev.request.url = stripAiBudgetQueries(ev.request.url);
      delete ev.request.query_string;
    }
  }
  if (typeof ev.transaction === 'string') ev.transaction = stripAiBudgetQueries(ev.transaction);
  for (const span of ev.spans ?? []) {
    const hit = scrubData(span.data);
    if (typeof span.description === 'string' && (hit || isAiBudgetUrl(span.description))) {
      span.description = stripAiBudgetQueries(span.description);
    }
  }
  for (const b of Array.isArray(ev.breadcrumbs) ? ev.breadcrumbs : []) scrubAiBudgetBreadcrumb(b);
  return event;
}

export function scrubAiBudgetBreadcrumb<B extends Sentry.Breadcrumb>(breadcrumb: B): B {
  scrubData(breadcrumb.data as Record<string, unknown> | undefined);
  if (typeof breadcrumb.message === 'string') breadcrumb.message = stripAiBudgetQueries(breadcrumb.message);
  return breadcrumb;
}

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info('[Sentry] SENTRY_DSN not set — Sentry disabled');
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    release: process.env.APP_VERSION,
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    integrations: [
      Sentry.httpIntegration(),
      Sentry.expressIntegration(),
      // Sentry.prismaIntegration() — uncomment if available in installed @sentry/node version.
      // Some v8 minor releases relocate it; if TS errors with "not exported", drop this line.
    ],
    // AI Budget URLs carry an OAuth code/state (callback) or private cursors and dates (outbound calls):
    // their query strings never reach Sentry, in errors, transactions or breadcrumbs.
    beforeSend: (event) => scrubAiBudgetEvent(event),
    beforeSendTransaction: (event) => scrubAiBudgetEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubAiBudgetBreadcrumb(breadcrumb),
  });

  logger.info(`[Sentry] Initialized for environment: ${process.env.NODE_ENV}`);
}

export { Sentry };
