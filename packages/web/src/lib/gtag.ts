export const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

/**
 * Pages whose URL carries a one-time secret (the AI Budget OAuth completion receives `?code&state`):
 * no page view is sent for them, and the page location is reported without its query string.
 */
export const NO_PAGE_VIEW_PATHS = ['/settings/integrations/ai-budget/complete'];

export function isNoPageViewPath(pathname: string): boolean {
  return NO_PAGE_VIEW_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

declare global {
  interface Window {
    gtag: (...args: [string, ...unknown[]]) => void;
    dataLayer: Record<string, unknown>[];
  }
}

export function pageview(url: string): void {
  if (typeof window.gtag !== 'function') return;
  window.gtag('config', GA_MEASUREMENT_ID!, {
    page_path: url,
  });
}

export function event(
  action: string,
  params?: {
    category?: string;
    label?: string;
    value?: number;
    [key: string]: unknown;
  }
): void {
  if (typeof window.gtag !== 'function') return;
  window.gtag('event', action, {
    event_category: params?.category,
    event_label: params?.label,
    value: params?.value,
    ...params,
  });
}
