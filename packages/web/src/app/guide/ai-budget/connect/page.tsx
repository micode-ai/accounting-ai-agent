'use client';
import { useLocale } from '@/contexts/LocaleContext';
import {
  GuidePageLayout,
  GuideStep,
  GuideCallout,
  GuideExternalLink,
} from '@/components/guide';
import en from '@/i18n/locales/en.json';
import pl from '@/i18n/locales/pl.json';
import ru from '@/i18n/locales/ru.json';

const translations = { en, pl, ru };

export default function AiBudgetConnectArticlePage() {
  const { locale } = useLocale();
  const guide = translations[locale].guide;
  const topic = guide.topics.aiBudget;
  const article = topic.articles.connect;

  return (
    <GuidePageLayout
      title={article.title}
      summary={article.summary}
      breadcrumbs={[
        { label: guide.breadcrumbHome, href: '/guide' },
        { label: topic.title, href: '/guide/ai-budget' },
        { label: article.title },
      ]}
      howToSteps={article.steps.map((s) => ({ name: s.title, text: s.body }))}
    >
      <p className="text-gray-700 dark:text-gray-300 leading-relaxed">{article.intro}</p>

      {article.steps.map((step, i) => (
        <GuideStep key={i} number={i + 1} title={step.title}>
          <p>{step.body}</p>
          {i === 3 && (
            <GuideCallout
              variant={article.callouts.shared.variant as 'info'}
              title={article.callouts.shared.title}
              body={article.callouts.shared.body}
            />
          )}
          {i === 6 && (
            <GuideCallout
              variant={article.callouts.reconnect.variant as 'warning'}
              title={article.callouts.reconnect.title}
              body={article.callouts.reconnect.body}
            />
          )}
        </GuideStep>
      ))}

      <section className="border-t border-gray-200 dark:border-gray-700 pt-6 mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
          {article.links.title}
        </h2>
        <ul className="space-y-2">
          {(['integrations', 'aiBudget'] as const).map((key) => {
            const link = article.links[key];
            return (
              <li key={key}>
                <GuideExternalLink href={link.href} label={link.label} />
              </li>
            );
          })}
        </ul>
      </section>
    </GuidePageLayout>
  );
}
