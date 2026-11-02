import { render } from '@testing-library/react';
import { GoogleAnalytics } from '../GoogleAnalytics';

// Mutable so a test can simulate a client-side navigation between renders.
const pathname = { current: '/' };
jest.mock('next/navigation', () => ({ usePathname: () => pathname.current }));

// next/script would try to inject real <script> tags into jsdom; the tags
// themselves are not what this test is about.
const scripts: Array<{ id?: string; dangerouslySetInnerHTML?: { __html: string } }> = [];
jest.mock('next/script', () => ({
  __esModule: true,
  default: (props: { id?: string; dangerouslySetInnerHTML?: { __html: string } }) => { scripts.push(props); return null; },
}));

// The measurement id is captured when @/lib/gtag is first evaluated, and CI has
// no .env file, so pin it from a hoisted factory that still returns the real module.
jest.mock('@/lib/gtag', () => {
  process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = 'G-TEST12345';
  return jest.requireActual('@/lib/gtag');
});

// Mutable so a test can simulate the visitor accepting analytics after load.
const analyticsAllowed = { current: true };
jest.mock('@/contexts/CookieConsentContext', () => ({
  useCookieConsent: () => ({
    state: {
      hasConsented: true,
      preferences: { necessary: true, analytics: analyticsAllowed.current },
    },
  }),
}));

describe('GoogleAnalytics page views', () => {
  beforeEach(() => {
    pathname.current = '/';
    analyticsAllowed.current = true;
    window.gtag = jest.fn();
  });

  const configCalls = () =>
    (window.gtag as unknown as jest.Mock).mock.calls.filter((c) => c[0] === 'config');

  it('leaves the first page view to the gtag init snippet', () => {
    render(<GoogleAnalytics />);
    expect(configCalls()).toHaveLength(0);
  });

  it('sends one page view per client-side navigation', () => {
    const { rerender } = render(<GoogleAnalytics />);
    pathname.current = '/pricing';
    rerender(<GoogleAnalytics />);

    expect(configCalls()).toHaveLength(1);
    expect(configCalls()[0][2]).toEqual({ page_path: '/pricing' });
  });

  it('does not double-count the current page when consent arrives after load', () => {
    analyticsAllowed.current = false;
    const { rerender } = render(<GoogleAnalytics />);

    // Visitor accepts analytics cookies: the gtag snippet mounts now and reports
    // this page itself, so the effect must stay quiet.
    analyticsAllowed.current = true;
    rerender(<GoogleAnalytics />);

    expect(configCalls()).toHaveLength(0);
  });

  it('sends no page view for the OAuth completion page (its URL carries a one-time code)', () => {
    const { rerender } = render(<GoogleAnalytics />);
    pathname.current = '/settings/integrations/ai-budget/complete';
    rerender(<GoogleAnalytics />);
    expect(configCalls()).toHaveLength(0);
  });
});

describe('GoogleAnalytics init snippet', () => {
  function runSnippet(url: string): unknown[][] {
    scripts.length = 0;
    window.history.replaceState(null, '', url);
    render(<GoogleAnalytics />);
    const html = scripts.find((s) => s.id === 'google-analytics-init')!.dangerouslySetInnerHTML!.__html;
    (window as unknown as { dataLayer: unknown[] }).dataLayer = [];
    new Function(html)();
    return (window as unknown as { dataLayer: IArguments[] }).dataLayer.map((a) => Array.from(a));
  }

  afterEach(() => window.history.replaceState(null, '', '/'));

  it('on the OAuth completion page sends no page view and never the query string', () => {
    const calls = runSnippet('/settings/integrations/ai-budget/complete?code=SECRETCODE&state=STATE1');
    const config = calls.find((c) => c[0] === 'config')!;
    expect(config[2]).toMatchObject({ send_page_view: false });
    expect(JSON.stringify(calls)).not.toContain('SECRETCODE');
  });

  it('on any other page keeps the full page location and sends the page view', () => {
    const calls = runSnippet('/pricing?utm_source=x');
    const config = calls.find((c) => c[0] === 'config')!;
    expect(config[2]).toMatchObject({ send_page_view: true, page_path: '/pricing' });
    expect(String((config[2] as { page_location: string }).page_location)).toContain('utm_source=x');
  });
});
