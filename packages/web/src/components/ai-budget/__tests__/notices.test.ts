import en from '@/i18n/locales/en.json';
import { disconnectNotice, ownText, redirectNotice } from '../notices';

const t = en.aiBudget;

describe('redirectNotice', () => {
  test('connected', () => {
    expect(redirectNotice('?ai_budget=connected', t)).toEqual({ kind: 'success', text: t.settings.connectedToast });
  });
  test('a known reason', () => {
    expect(redirectNotice('?ai_budget=error&reason=access_denied', t)).toEqual({ kind: 'error', text: t.settings.error.access_denied });
  });
  test.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'nonsense', ''])('reason %p falls back to unknown', (reason) => {
    expect(redirectNotice(`?ai_budget=error&reason=${reason}`, t)).toEqual({ kind: 'error', text: t.settings.error.unknown });
  });
  test('no result → null', () => {
    expect(redirectNotice('', t)).toBeNull();
  });
});

describe('ownText', () => {
  test('only own string keys', () => {
    expect(ownText({ a: 'x' }, 'a')).toBe('x');
    expect(ownText({ a: 'x' }, '__proto__')).toBeUndefined();
    expect(ownText({ a: 'x' }, null)).toBeUndefined();
  });
});

describe('disconnectNotice', () => {
  test('revoked or nothing to revoke → no notice', () => {
    expect(disconnectNotice({ revokedRemotely: true, remote: 'revoked' }, t)).toBeNull();
    expect(disconnectNotice({ revokedRemotely: false, remote: 'none' }, t)).toBeNull();
  });
  test('an active grant that could not be revoked → the warning', () => {
    expect(disconnectNotice({ revokedRemotely: false, remote: 'failed' }, t)).toEqual({ kind: 'error', text: t.settings.disconnectRemoteFailed });
  });
  test('an expired grant (needs_reconnect) → a neutral note, never "could not revoke"', () => {
    const n = disconnectNotice({ revokedRemotely: false, remote: 'expired' }, t);
    expect(n).toEqual({ kind: 'success', text: t.settings.disconnectExpired });
    expect(n!.text).not.toBe(t.settings.disconnectRemoteFailed);
  });
  test('an older server without `remote` falls back to revokedRemotely', () => {
    expect(disconnectNotice({ revokedRemotely: false }, t)).toEqual({ kind: 'error', text: t.settings.disconnectRemoteFailed });
  });
});
