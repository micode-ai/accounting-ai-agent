'use client';

import { useEffect, useRef } from 'react';
import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useCookieConsent } from '@/contexts/CookieConsentContext';
import { GA_MEASUREMENT_ID, NO_PAGE_VIEW_PATHS, isNoPageViewPath, pageview } from '@/lib/gtag';

export function GoogleAnalytics() {
  const { state } = useCookieConsent();
  const pathname = usePathname();

  const analyticsConsented = state.hasConsented && state.preferences.analytics;

  // The gtag init snippet below reports the page it mounts on (send_page_view),
  // so the first run here would count that view a second time. Report only the
  // client-side navigations that follow.
  const reportedInitialView = useRef(false);

  useEffect(() => {
    if (!analyticsConsented || !GA_MEASUREMENT_ID) return;
    if (!reportedInitialView.current) {
      reportedInitialView.current = true;
      return;
    }
    if (isNoPageViewPath(pathname)) return;
    pageview(pathname);
  }, [pathname, analyticsConsented]);

  if (!GA_MEASUREMENT_ID || !analyticsConsented) {
    return null;
  }

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
        strategy="afterInteractive"
      />
      <Script
        id="google-analytics-init"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{
          __html: `
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            var noPageView = ${JSON.stringify(NO_PAGE_VIEW_PATHS)}.some(function (p) {
              return window.location.pathname === p || window.location.pathname.indexOf(p + '/') === 0;
            });
            gtag('config', '${GA_MEASUREMENT_ID}', {
              page_path: window.location.pathname,
              page_location: noPageView ? window.location.origin + window.location.pathname : window.location.href,
              send_page_view: !noPageView,
            });
          `,
        }}
      />
    </>
  );
}
