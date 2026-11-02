import { scrubAiBudgetBreadcrumb, scrubAiBudgetEvent } from '../sentry';

describe('Sentry scrubbing of AI Budget URLs', () => {
  test('the OAuth callback request loses its query (code and state)', () => {
    const ev = scrubAiBudgetEvent({
      request: { url: 'https://api.eksiegowyai.pl/api/integrations/ai-budget/callback?code=SECRET&state=ST', query_string: 'code=SECRET&state=ST', headers: { authorization: 'Bearer x', cookie: 'c' } },
    } as never);
    expect(JSON.stringify(ev)).not.toContain('SECRET');
    expect((ev as { request: { url: string } }).request.url).toBe('https://api.eksiegowyai.pl/api/integrations/ai-budget/callback');
    expect((ev as { request: { headers: Record<string, unknown> } }).request.headers).toEqual({});
  });

  test('outbound AI Budget spans and breadcrumbs lose their query; other URLs are untouched', () => {
    const ev = scrubAiBudgetEvent({
      spans: [
        { description: 'GET https://api.ai-budget.pl/public/v1/expenses?search=Kino&date_from=2026-11-01', data: { url: 'https://api.ai-budget.pl/public/v1/expenses?search=Kino', 'http.query': 'search=Kino', 'url.query': '?search=Kino', 'url.full': 'https://api.ai-budget.pl/public/v1/expenses?search=Kino' } },
        { description: 'GET https://api.wfirma.pl/expenses/find?x=1', data: { url: 'https://api.wfirma.pl/expenses/find?x=1' } },
      ],
      breadcrumbs: [{ category: 'http', data: { url: 'https://api.ai-budget.pl/public/v1/expenses?search=Kino', 'http.query': 'search=Kino' } }],
    } as never);
    const s = JSON.stringify(ev);
    expect(s).not.toContain('Kino');
    expect(s).toContain('https://api.wfirma.pl/expenses/find?x=1');
    expect(s).toContain('GET https://api.ai-budget.pl/public/v1/expenses');
  });

  test('beforeBreadcrumb strips the query of an AI Budget request', () => {
    const b = scrubAiBudgetBreadcrumb({ category: 'http', data: { url: 'https://api.ai-budget.pl/oauth/token?x=1', 'http.query': 'x=1', method: 'POST' } });
    expect(b.data).toEqual({ url: 'https://api.ai-budget.pl/oauth/token', method: 'POST' });
  });
});
