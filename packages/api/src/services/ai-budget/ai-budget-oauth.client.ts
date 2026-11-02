import { AiBudgetConfig } from './ai-budget.config';
import { AiBudgetApiError, apiErrorFromResponse } from './ai-budget-errors';
import { AiBudgetTransport } from './ai-budget-transport';
import { TokenResponse } from './ai-budget.types';

/** OAuth endpoints, authenticated with client_secret_basic. */
export class AiBudgetOAuthClient {
  constructor(private readonly config: AiBudgetConfig, private readonly transport: AiBudgetTransport) {}

  exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri, code_verifier: codeVerifier });
  }

  /** An OAuth error becomes AiBudgetApiError(status, error), e.g. (400, 'invalid_grant'). */
  refresh(refreshToken: string): Promise<TokenResponse> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /** Revokes the whole connection. Call only on a user-initiated disconnect. */
  async revoke(token: string): Promise<void> {
    const res = await this.transport.request({
      method: 'POST', url: this.config.revokeUrl, headers: this.authHeader(), form: { token, token_type_hint: 'refresh_token' },
    });
    if (res.status < 200 || res.status >= 300) throw apiErrorFromResponse(res.status, res.headers, res.data);
  }

  private async token(form: Record<string, string>): Promise<TokenResponse> {
    const res = await this.transport.request({ method: 'POST', url: this.config.tokenUrl, headers: this.authHeader(), form });
    if (res.status < 200 || res.status >= 300) throw apiErrorFromResponse(res.status, res.headers, res.data);
    const d = res.data as Partial<TokenResponse> | null;
    if (
      !d || typeof d.access_token !== 'string' || !d.access_token || typeof d.refresh_token !== 'string' || !d.refresh_token ||
      typeof d.expires_in !== 'number' || !(d.expires_in > 0)
    ) {
      throw new AiBudgetApiError(res.status, 'invalid_token_response');
    }
    return {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_in: d.expires_in,
      scope: typeof d.scope === 'string' ? d.scope : '',
      account_ids: Array.isArray(d.account_ids) ? d.account_ids.filter((x): x is string => typeof x === 'string') : [],
    };
  }

  private authHeader(): Record<string, string> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    return { Authorization: `Basic ${basic}` };
  }
}
