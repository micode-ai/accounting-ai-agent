'use client';

import Link from 'next/link';
import type { AiBudgetT } from './types';

export function AiBudgetInviteCard({ t }: { t: AiBudgetT }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700 p-3">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t.invite.title}</h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t.invite.body}</p>
      <Link
        href="/settings/integrations"
        className="inline-block mt-2 px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700"
      >
        {t.invite.cta}
      </Link>
    </div>
  );
}
