import { cryptoService } from '../crypto.instance';

export const AI_BUDGET_SCOPES = 'expenses:read expenses:write categories:read receipts:read';

export interface AiBudgetConfig {
  clientId: string;
  clientSecret: string;
  apiUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  redirectUri: string;
  frontendUrl: string;
}

const stripSlash = (s: string): string => s.trim().replace(/\/+$/, '');

/** Tokens and the client secret travel on these URLs: https only, http allowed outside production. */
function isAllowedUrl(url: string, production: boolean): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || (!production && protocol === 'http:');
  } catch {
    return false;
  }
}

/** Returns null (feature hidden) when any required setting is missing. */
export function getAiBudgetConfig(
  env: Record<string, string | undefined> = process.env,
  encryptionConfigured: boolean = cryptoService.isConfigured(),
): AiBudgetConfig | null {
  const clientId = (env.AI_BUDGET_CLIENT_ID ?? '').trim();
  const clientSecret = (env.AI_BUDGET_CLIENT_SECRET ?? '').trim();
  const backendUrl = stripSlash(env.BACKEND_URL ?? '');
  const frontendUrl = stripSlash(env.FRONTEND_URL ?? '');
  if (!clientId || !clientSecret || !backendUrl || !frontendUrl || !encryptionConfigured) return null;

  const apiUrl = stripSlash(env.AI_BUDGET_API_URL || 'https://api.ai-budget.pl');
  const authorizeUrl = stripSlash(env.AI_BUDGET_AUTHORIZE_URL || 'https://app.ai-budget.pl/authorize');
  const production = env.NODE_ENV === 'production';
  if (!isAllowedUrl(apiUrl, production) || !isAllowedUrl(authorizeUrl, production)) return null;
  return {
    clientId,
    clientSecret,
    apiUrl,
    authorizeUrl,
    tokenUrl: `${apiUrl}/oauth/token`,
    revokeUrl: `${apiUrl}/oauth/revoke`,
    redirectUri: `${backendUrl}/api/integrations/ai-budget/callback`,
    frontendUrl,
  };
}
