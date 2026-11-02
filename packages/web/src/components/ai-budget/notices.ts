import type { AiBudgetDisconnectResultDto } from '@/types/ai-budget.types';
import type { AiBudgetT } from './types';

export type Notice = { kind: 'success' | 'error'; text: string } | null;

/** Looks up a translation by a key that comes from the server or the URL: own string keys only (`__proto__` is not a key). */
export function ownText(map: Record<string, unknown>, key: string | null | undefined): string | undefined {
  if (key == null || !Object.prototype.hasOwnProperty.call(map, key)) return undefined;
  const v = map[key];
  return typeof v === 'string' ? v : undefined;
}

/** The `?ai_budget=` result of the OAuth round trip. */
export function redirectNotice(search: string, t: AiBudgetT): Notice {
  const params = new URLSearchParams(search);
  const result = params.get('ai_budget');
  if (!result) return null;
  if (result === 'connected') return { kind: 'success', text: t.settings.connectedToast };
  const errors = t.settings.error as Record<string, string>;
  return { kind: 'error', text: ownText(errors, params.get('reason')) ?? errors.unknown };
}

export function disconnectNotice(r: AiBudgetDisconnectResultDto, t: AiBudgetT): Notice {
  const remote = r.remote ?? (r.revokedRemotely ? 'revoked' : 'failed');
  if (remote === 'failed') return { kind: 'error', text: t.settings.disconnectRemoteFailed };
  if (remote === 'expired') return { kind: 'success', text: t.settings.disconnectExpired };
  return null;
}
