import axios from 'axios';
import { AiBudgetApiError } from './ai-budget-errors';

export interface TransportRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: Record<string, string>;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  data: unknown;
}

export interface AiBudgetTransport {
  request(req: TransportRequest): Promise<TransportResponse>;
}

/**
 * Real HTTP transport. Every status is returned (validateStatus: () => true); a network failure
 * becomes AiBudgetApiError(0, ...) so the axios error — whose config holds the Authorization
 * header and the form body — never escapes.
 */
export function createAxiosTransport(timeoutMs: number = 15000): AiBudgetTransport {
  const http = axios.create({ timeout: timeoutMs, validateStatus: () => true, maxRedirects: 0 });
  return {
    async request(req: TransportRequest): Promise<TransportResponse> {
      const params: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) params[k] = v;
      const headers: Record<string, string> = { Accept: 'application/json', ...(req.headers ?? {}) };
      let data: unknown;
      if (req.form) {
        data = new URLSearchParams(req.form).toString();
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      } else if (req.json !== undefined) {
        data = req.json;
        headers['Content-Type'] = 'application/json';
      }
      let res;
      try {
        res = await http.request({ method: req.method, url: req.url, params, headers, data });
      } catch (err) {
        const code = axios.isAxiosError(err) && err.code === 'ECONNABORTED' ? 'timeout' : 'network_error';
        throw new AiBudgetApiError(0, code);
      }
      const outHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers ?? {})) {
        if (v !== undefined && v !== null) outHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
      }
      return { status: res.status, headers: outHeaders, data: res.data };
    },
  };
}
