import { Metadata } from 'next';
import { buildPageMetadata, type Locale, type PageMeta } from '@/lib/seo';
import { getRequestLocale } from '@/lib/locale.server';

const META: Record<Locale, PageMeta> = {
  pl: {
    title: 'Jak połączyć AI Budget',
    description:
      'Krok po kroku: połącz AI Budget, wybierz konto firmowe, uzgadniaj wydatki i rozłącz, gdy zechcesz.',
  },
  en: {
    title: 'How to Connect AI Budget',
    description:
      'Step by step: connect AI Budget, choose your company account, reconcile expenses and disconnect whenever you like.',
  },
  ru: {
    title: 'Как подключить AI Budget',
    description:
      'Пошагово: подключите AI Budget, выберите счёт компании, сверяйте расходы и отключайтесь в любой момент.',
  },
};

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  return buildPageMetadata(META, '/guide/ai-budget/connect', locale);
}

export default function GuideAiBudgetConnectLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
