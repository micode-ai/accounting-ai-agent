// Errors carry only a status and a code: never a token, a header, a URL with a query or a body.

export class AiBudgetNotConnectedError extends Error {
  constructor() {
    super('AI Budget is not connected');
    this.name = 'AiBudgetNotConnectedError';
  }
}

export class AiBudgetReconnectRequiredError extends Error {
  constructor() {
    super('AI Budget connection must be reconnected');
    this.name = 'AiBudgetReconnectRequiredError';
  }
}

/** The account row does not exist among the user's own accounts. */
export class AiBudgetAccountNotFoundError extends Error {
  constructor() {
    super('AI Budget account not found');
    this.name = 'AiBudgetAccountNotFoundError';
  }
}

/** An inactive or unavailable account cannot be made the company. */
export class AiBudgetAccountUnavailableError extends Error {
  constructor() {
    super('An inactive or unavailable AI Budget account cannot be the company');
    this.name = 'AiBudgetAccountUnavailableError';
  }
}

export class AiBudgetApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfterSec?: number) {
    super(`AI Budget request failed: ${status} ${code}`);
    this.name = 'AiBudgetApiError';
  }
}

/** 403 codes that concern one account of the connection, not the whole connection. */
export const ACCOUNT_ACCESS_CODES = ['account_not_granted', 'grant_inactive', 'account_encrypted'] as const;

/** Reads `Retry-After` (seconds or an HTTP date); undefined when absent or unreadable. */
export function parseRetryAfter(value: string | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * Builds the error from a non-2xx response. Understands both the public API envelope
 * `{ error: { code } }` and the OAuth format `{ error: "code" }`; anything else is `http_<status>`.
 */
export function apiErrorFromResponse(status: number, headers: Record<string, string>, data: unknown): AiBudgetApiError {
  let code = `http_${status}`;
  if (data && typeof data === 'object' && 'error' in data) {
    const e = (data as { error: unknown }).error;
    if (typeof e === 'string' && e) code = e;
    else if (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string') code = (e as { code: string }).code;
  }
  return new AiBudgetApiError(status, code, parseRetryAfter(headers['retry-after']));
}
