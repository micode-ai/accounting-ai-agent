import { Metadata } from 'next';
import { buildPageMetadata, type Locale, type PageMeta } from '@/lib/seo';
import { getRequestLocale } from '@/lib/locale.server';

const META: Record<Locale, PageMeta> = {
  pl: {
    title: 'Integracja z AI Budget',
    description:
      'Połącz AI Budget Assistant z eKsięgowy AI, wybierz konto firmowe i uzgadniaj wydatki z dokumentami we wFirma.',
  },
  en: {
    title: 'AI Budget Integration',
    description:
      'Connect AI Budget Assistant to eKsięgowy AI, choose your company account and reconcile expenses with wFirma documents.',
  },
  ru: {
    title: 'Интеграция с AI Budget',
    description:
      'Подключите AI Budget Assistant к eKsięgowy AI, выберите счёт компании и сверяйте расходы с документами wFirma.',
  },
};

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  return buildPageMetadata(META, '/guide/ai-budget', locale);
}

export default function GuideAiBudgetLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
