'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { useLocale } from '@/contexts/LocaleContext';
import { ApiError } from '@/lib/api/api-client';
import { completeAiBudgetConnect } from '@/lib/api/ai-budget';
import en from '@/i18n/locales/en.json';
import pl from '@/i18n/locales/pl.json';
import ru from '@/i18n/locales/ru.json';

const translations = { en, pl, ru };
const STORAGE_KEY = 'aiBudgetOAuthPending';
const KNOWN_REASONS = ['invalid_state', 'state_mismatch', 'access_denied', 'exchange_failed', 'unavailable'];

/**
 * OAuth completion. The code and state arrive in the URL, are moved into sessionStorage and removed from
 * the address bar immediately, so they survive a login redirect but never sit in history or a Referer.
 * The capture runs outside ProtectedRoute: a logged-out visitor never mounts its children.
 */
export default function AiBudgetCompletePage() {
  const [captured, setCaptured] = useState(false);

  // A layout effect runs before every passive effect in the tree (analytics included), so the code and
  // state are gone from the address bar before anything can read or report the URL.
  useLayoutEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (code && state) {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ code, state }));
      } catch {
        // sessionStorage unavailable: the completion below reports invalid_state.
      }
    }
    window.history.replaceState(null, '', window.location.pathname);
    setCaptured(true);
  }, []);

  if (!captured) return null;
  return (
    <ProtectedRoute>
      <CompleteContent />
    </ProtectedRoute>
  );
}

function takePending(): { code: string; state: string } | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { code?: unknown; state?: unknown };
    return typeof v.code === 'string' && typeof v.state === 'string' ? { code: v.code, state: v.state } : null;
  } catch {
    return null;
  }
}

function CompleteContent() {
  const router = useRouter();
  const { locale } = useLocale();
  const t = translations[locale].aiBudget.settings;
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const fail = (reason: string) =>
      router.replace(`/settings/integrations?ai_budget=error&reason=${encodeURIComponent(reason)}`);

    const pending = takePending();
    if (!pending) {
      fail('invalid_state');
      return;
    }
    completeAiBudgetConnect(pending.code, pending.state)
      .then(() => router.replace('/settings/integrations?ai_budget=connected'))
      .catch((err: unknown) => {
        const code = err instanceof ApiError ? err.code : '';
        fail(KNOWN_REASONS.includes(code) ? code : 'unknown');
      });
  }, [router]);

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-gray-50 px-4 text-center dark:bg-gray-900">
      <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      <p className="text-sm text-gray-700 dark:text-gray-300">{t.connecting}</p>
    </div>
  );
}
