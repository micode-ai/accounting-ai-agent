import type { Metadata } from 'next';
import React from 'react';

// The URL carries a one-time OAuth code: never leak it through the Referer header.
export const metadata: Metadata = {
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default function CompleteLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
