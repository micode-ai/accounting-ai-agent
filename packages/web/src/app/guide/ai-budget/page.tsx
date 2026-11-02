'use client';
import { LocaleLink as Link } from '@/components/LocaleLink';
import { ChevronRight, FileText } from 'lucide-react';
import { useLocale } from '@/contexts/LocaleContext';
import { GuidePageLayout } from '@/components/guide';
import en from '@/i18n/locales/en.json';
import pl from '@/i18n/locales/pl.json';
import ru from '@/i18n/locales/ru.json';

const translations = { en, pl, ru };

const ARTICLES = [{ slug: 'connect', i18nKey: 'connect' as const }];

export default function AiBudgetTopicPage() {
  const { locale } = useLocale();
  const guide = translations[locale].guide;
  const topic = guide.topics.aiBudget;

  return (
    <GuidePageLayout
      title={topic.title}
      summary={topic.description}
      breadcrumbs={[
        { label: guide.breadcrumbHome, href: '/guide' },
        { label: topic.title },
      ]}
    >
      <div className="grid gap-3">
        {ARTICLES.map((a) => {
          const article = topic.articles[a.i18nKey];
          return (
            <Link
              key={a.slug}
              href={`/guide/ai-budget/${a.slug}`}
              className="group flex items-start gap-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-5 hover:border-blue-400 dark:hover:border-blue-500 transition-colors"
            >
              <FileText className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <h2 className="font-semibold text-gray-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400">
                  {article.title}
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{article.summary}</p>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400 flex-shrink-0 mt-1" />
            </Link>
          );
        })}
      </div>
    </GuidePageLayout>
  );
}
