import { logger } from '../../utils/logger';
import { AiBudgetConfig } from './ai-budget.config';
import { ACCOUNT_ACCESS_CODES, apiErrorFromResponse } from './ai-budget-errors';
import { AiBudgetTokenManager } from './ai-budget-token.manager';
import { AiBudgetTransport, TransportRequest, TransportResponse } from './ai-budget-transport';
import { PublicExpenseWire, RemoteAccount, RemoteCategory } from './ai-budget.types';

export interface ExpensePage { data: PublicExpenseWire[]; next_cursor: string | null; has_more: boolean }
export interface ChangesPage {
  changes: Array<{ type: 'upsert'; expense: PublicExpenseWire } | { type: 'delete'; id: string }>;
  next_cursor: string;
  has_more: boolean;
}
export interface ExpenseCreateBody { amount: string; currency?: string; date: string; category_id?: string; merchant?: string; description?: string }
export type ExpenseUpdateBody = Partial<{
  amount: string; currency: string; date: string; category_id: string | null; merchant: string | null; description: string | null;
}>;

export type AccountAccessListener = (userId: string, accountExternalId: string, code: string) => Promise<void>;

interface CallSpec {
  method: TransportRequest['method'];
  path: string;
  accountId?: string;
  query?: TransportRequest['query'];
  json?: unknown;
  headers?: Record<string, string>;
}

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertAmount(amount: unknown): void {
  if (typeof amount !== 'string' || !AMOUNT_RE.test(amount)) {
    throw new Error('AI Budget amount must be a decimal string with at most 2 decimal places');
  }
}

/** Public API v1 client. Every account-scoped call sends X-Account-Id. */
export class AiBudgetApiClient {
  private accountAccessListener: AccountAccessListener | null = null;

  constructor(
    private readonly config: AiBudgetConfig,
    private readonly transport: AiBudgetTransport,
    private readonly tokens: AiBudgetTokenManager,
  ) {}

  setAccountAccessListener(fn: AccountAccessListener): void {
    this.accountAccessListener = fn;
  }

  async listAccounts(userId: string): Promise<RemoteAccount[]> {
    const res = await this.call<{ data: RemoteAccount[] }>(userId, { method: 'GET', path: '/public/v1/accounts' });
    return res.data;
  }

  listExpenses(
    userId: string,
    accountId: string,
    q: { date_from?: string; date_to?: string; category_id?: string; search?: string; limit?: number; cursor?: string },
  ): Promise<ExpensePage> {
    return this.call<ExpensePage>(userId, { method: 'GET', path: '/public/v1/expenses', accountId, query: { ...q } });
  }

  getChanges(userId: string, accountId: string, cursor: string | null, limit: number = 200): Promise<ChangesPage> {
    return this.call<ChangesPage>(userId, {
      method: 'GET', path: '/public/v1/expenses/changes', accountId, query: { limit, ...(cursor ? { cursor } : {}) },
    });
  }

  async listCategories(userId: string, accountId: string): Promise<RemoteCategory[]> {
    const res = await this.call<{ data: RemoteCategory[] }>(userId, { method: 'GET', path: '/public/v1/categories', accountId });
    return res.data;
  }

  async createExpense(userId: string, accountId: string, body: ExpenseCreateBody, idempotencyKey: string): Promise<PublicExpenseWire> {
    assertAmount(body.amount);
    if (!UUID_V4_RE.test(idempotencyKey)) throw new Error('AI Budget Idempotency-Key must be a UUID v4');
    return this.call<PublicExpenseWire>(userId, {
      method: 'POST', path: '/public/v1/expenses', accountId, json: body, headers: { 'Idempotency-Key': idempotencyKey },
    });
  }

  async updateExpense(userId: string, accountId: string, expenseId: string, body: ExpenseUpdateBody): Promise<PublicExpenseWire> {
    if ('amount' in body) assertAmount(body.amount);
    return this.call<PublicExpenseWire>(userId, {
      method: 'PATCH', path: `/public/v1/expenses/${encodeURIComponent(expenseId)}`, accountId, json: body,
    });
  }

  async deleteExpense(userId: string, accountId: string, expenseId: string): Promise<void> {
    await this.call<unknown>(userId, { method: 'DELETE', path: `/public/v1/expenses/${encodeURIComponent(expenseId)}`, accountId });
  }

  /** One refresh and one retry after a 401 invalid_token; errors carry only status and code. */
  private async call<T>(userId: string, spec: CallSpec): Promise<T> {
    let token = await this.tokens.getAccessToken(userId);
    let res = await this.send(spec, token);
    if (res.status === 401 && apiErrorFromResponse(res.status, res.headers, res.data).code === 'invalid_token') {
      token = await this.tokens.forceRefresh(userId, token);
      res = await this.send(spec, token);
    }
    if (res.status >= 200 && res.status < 300) return (res.status === 204 ? undefined : res.data) as T;

    const err = apiErrorFromResponse(res.status, res.headers, res.data);
    logger.warn('AI Budget API call failed', { userId, accountId: spec.accountId, status: err.status, code: err.code });
    if (
      res.status === 403 && spec.accountId && this.accountAccessListener &&
      (ACCOUNT_ACCESS_CODES as readonly string[]).includes(err.code)
    ) {
      try {
        await this.accountAccessListener(userId, spec.accountId, err.code);
      } catch {
        logger.warn('AI Budget account access listener failed', { userId, accountId: spec.accountId, code: err.code });
      }
    }
    throw err;
  }

  private send(spec: CallSpec, token: string): Promise<TransportResponse> {
    const headers: Record<string, string> = { ...(spec.headers ?? {}), Authorization: `Bearer ${token}` };
    if (spec.accountId) headers['X-Account-Id'] = spec.accountId;
    return this.transport.request({
      method: spec.method,
      url: `${this.config.apiUrl}${spec.path}`,
      headers,
      ...(spec.query ? { query: spec.query } : {}),
      ...(spec.json !== undefined ? { json: spec.json } : {}),
    });
  }
}
