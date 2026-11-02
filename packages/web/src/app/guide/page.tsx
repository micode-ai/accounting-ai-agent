'use client';
import { LocaleLink as Link } from '@/components/LocaleLink';
import { ChevronRight } from 'lucide-react';
import { useLocale } from '@/contexts/LocaleContext';
import { GuidePageLayout } from '@/components/guide';
import en from '@/i18n/locales/en.json';
import pl from '@/i18n/locales/pl.json';
import ru from '@/i18n/locales/ru.json';

const translations = { en, pl, ru };

const TOPICS = [
  { slug: 'ksef', i18nKey: 'ksef' as const },
  { slug: 'wfirma', i18nKey: 'wfirma' as const },
  { slug: 'telegram', i18nKey: 'telegram' as const },
  { slug: 'ai-budget', i18nKey: 'aiBudget' as const },
];

export default function GuideIndexPage() {
  const { locale } = useLocale();
  const t = translations[locale].guide;

  return (
    <GuidePageLayout
      title={t.title}
      summary={t.description}
      breadcrumbs={[{ label: t.breadcrumbHome }]}
    >
      <div className="grid gap-4">
        {TOPICS.map((topic) => {
          const data = t.topics[topic.i18nKey];
          return (
            <Link
              key={topic.slug}
              href={`/guide/${topic.slug}`}
              className="group flex items-center justify-between bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-5 hover:border-blue-400 dark:hover:border-blue-500 transition-colors"
            >
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400">
                  {data.title}
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{data.description}</p>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400 flex-shrink-0" />
            </Link>
          );
        })}
      </div>
    </GuidePageLayout>
  );
}
