// Test doubles for the AI Budget integration. Never makes a live HTTP or Redis call.
import type { RedisLike } from '../../../lib/redis';
import type {
  AccountRow, AccountUpsert, AiBudgetRepository, MirrorExpenseInput, MirrorExpenseRow,
} from '../ai-budget.repository';
import type { AiBudgetLabel, AiBudgetLabelSource } from '../ai-budget.types';
import type { ConnectionRow, StoredTokens } from '../ai-budget-token.manager';
import type { AiBudgetTransport, TransportRequest, TransportResponse } from '../ai-budget-transport';

interface QueuedResponse { status: number; data: unknown; headers: Record<string, string> }

/** Answers from a per-"METHOD path" queue and records every request. */
export class FakeTransport implements AiBudgetTransport {
  readonly requests: TransportRequest[] = [];
  private readonly queues = new Map<string, QueuedResponse[]>();

  queue(key: string, status: number, data: unknown, headers: Record<string, string> = {}): this {
    const list = this.queues.get(key) ?? [];
    list.push({ status, data, headers });
    this.queues.set(key, list);
    return this;
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    this.requests.push(req);
    const key = `${req.method} ${new URL(req.url).pathname}`;
    const next = this.queues.get(key)?.shift();
    if (!next) throw new Error(`FakeTransport: no response queued for ${key}`);
    return { status: next.status, headers: next.headers, data: next.data };
  }
}

/** In-memory RedisLike with TTLs on a manual clock (advance(ms)). */
export class FakeRedis implements RedisLike {
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();
  private clock = 0;

  advance(ms: number): void { this.clock += ms; }

  private live(key: string): string | null {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= this.clock) { this.store.delete(key); return null; }
    return e.value;
  }

  async get(key: string): Promise<string | null> { return this.live(key); }

  async setEx(key: string, seconds: number, value: string): Promise<'OK'> {
    this.store.set(key, { value, expiresAt: this.clock + seconds * 1000 });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    const existed = this.live(key) !== null;
    this.store.delete(key);
    return existed ? 1 : 0;
  }

  async incr(key: string): Promise<number> {
    const n = Number(this.live(key) ?? '0') + 1;
    const prev = this.store.get(key);
    this.store.set(key, { value: String(n), expiresAt: prev?.expiresAt ?? null });
    return n;
  }

  async setNxPx(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (this.live(key) !== null) return false;
    this.store.set(key, { value, expiresAt: this.clock + ttlMs });
    return true;
  }

  async getDel(key: string): Promise<string | null> {
    const v = this.live(key);
    this.store.delete(key);
    return v;
  }

  async delIfEquals(key: string, value: string): Promise<boolean> {
    if (this.live(key) !== value) return false;
    this.store.delete(key);
    return true;
  }
}

/** In-memory AiBudgetRepository. Account rows get the id `<externalId>-row`. Throws if two companies would coexist (the DB partial unique index). */
export class InMemoryAiBudgetRepository implements AiBudgetRepository {
  readonly connections = new Map<string, ConnectionRow>();
  readonly accountRows = new Map<string, AccountRow>();
  private readonly mirror = new Map<string, Map<string, MirrorExpenseRow & { syncGeneration: number }>>();
  private readonly dismissed = new Map<string, Map<string, string | null>>();

  seedConnection(userId: string, over: Partial<ConnectionRow> = {}): ConnectionRow {
    const c: ConnectionRow = {
      id: `${userId}-conn`, userId, accessTokenEnc: 'enc', refreshTokenEnc: 'enc', accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      scope: 'expenses:read', status: 'active', statusChangedAt: new Date(), needsCompanyChoice: false, ...over,
    };
    this.connections.set(userId, c);
    return c;
  }

  seedAccount(userId: string, a: Partial<AccountRow> & { externalId: string }): AccountRow {
    const row: AccountRow = {
      id: `${a.externalId}-row`, connectionId: `${userId}-conn`, userId, name: a.externalId, type: 'personal', currency: 'PLN',
      access: 'read', active: true, inactiveReason: null, label: 'private', labelSource: 'auto', syncCursor: null, syncGeneration: 0,
      lastSyncedAt: null, lastSyncError: null, fullResyncAt: null, ...a,
    };
    this.accountRows.set(row.id, row);
    return row;
  }

  seedExpense(accountRowId: string, externalId: string, over: Partial<MirrorExpenseInput> = {}): void {
    const m = this.mirror.get(accountRowId) ?? new Map();
    m.set(externalId, {
      accountId: accountRowId, externalId, amount: '10.00', currency: 'PLN', date: '2026-11-01', categoryId: null, categorySplits: [],
      merchant: null, description: null, isDebt: false, isSplitReceivable: false, remoteUpdatedAt: new Date('2026-11-01T00:00:00Z'),
      syncGeneration: 0, ...over,
    });
    this.mirror.set(accountRowId, m);
  }

  seedDismissal(accountRowId: string, externalExpenseId: string): void {
    const d = this.dismissed.get(accountRowId) ?? new Map();
    d.set(externalExpenseId, null);
    this.dismissed.set(accountRowId, d);
  }

  expenses(accountRowId: string): MirrorExpenseRow[] { return [...(this.mirror.get(accountRowId)?.values() ?? [])]; }
  dismissals(accountRowId: string): string[] { return [...(this.dismissed.get(accountRowId)?.keys() ?? [])]; }

  private assertOneCompany(userId: string): void {
    const n = [...this.accountRows.values()].filter((a) => a.userId === userId && a.label === 'company').length;
    if (n > 1) throw new Error('unique violation: more than one company account per connection');
  }

  async getConnection(userId: string): Promise<ConnectionRow | null> { return this.connections.get(userId) ?? null; }

  async upsertConnectionTokens(userId: string, t: StoredTokens): Promise<ConnectionRow> {
    const prev = this.connections.get(userId) ?? this.seedConnection(userId);
    const next = { ...prev, ...t, status: 'active' as const, statusChangedAt: new Date() };
    this.connections.set(userId, next);
    return next;
  }

  async updateTokens(connectionId: string, previousRefreshTokenEnc: string, t: StoredTokens): Promise<boolean> {
    for (const [u, c] of this.connections) {
      if (c.id === connectionId && c.status !== 'revoked' && c.refreshTokenEnc === previousRefreshTokenEnc) {
        this.connections.set(u, { ...c, ...t });
        return true;
      }
    }
    return false;
  }

  async setConnectionStatus(userId: string, status: ConnectionRow['status'], at: Date): Promise<void> {
    const c = this.connections.get(userId);
    if (c && (status === 'revoked' || c.status !== 'revoked')) this.connections.set(userId, { ...c, status, statusChangedAt: at });
  }

  async setNeedsCompanyChoice(userId: string, value: boolean): Promise<void> {
    const c = this.connections.get(userId);
    if (c) this.connections.set(userId, { ...c, needsCompanyChoice: value });
  }

  async clearTokens(userId: string): Promise<void> {
    const c = this.connections.get(userId);
    if (c) {
      this.connections.set(userId, {
        ...c, accessTokenEnc: null, refreshTokenEnc: null, accessTokenExpiresAt: null, status: 'revoked', statusChangedAt: new Date(),
      });
    }
  }

  /** Users marked soft-deleted (User.deletedAt set). */
  readonly deletedUserIds = new Set<string>();
  async listActiveConnections(): Promise<ConnectionRow[]> {
    return [...this.connections.values()].filter((c) => c.status === 'active' && !this.deletedUserIds.has(c.userId));
  }

  async listReconnectOlderThan(cutoff: Date): Promise<ConnectionRow[]> {
    return [...this.connections.values()].filter((c) => c.status === 'needs_reconnect' && c.statusChangedAt < cutoff);
  }

  async listAccounts(userId: string): Promise<AccountRow[]> { return [...this.accountRows.values()].filter((a) => a.userId === userId); }

  async replaceLabels(userId: string, labels: { externalId: string; label: AiBudgetLabel; labelSource: AiBudgetLabelSource }[], clearMirrorExternalIds: string[] = []): Promise<void> {
    const ordered = [...labels.filter((l) => l.label !== 'company'), ...labels.filter((l) => l.label === 'company')];
    for (const l of ordered) {
      const row = [...this.accountRows.values()].find((a) => a.userId === userId && a.externalId === l.externalId);
      if (row) this.accountRows.set(row.id, { ...row, label: l.label, labelSource: l.labelSource });
    }
    this.assertOneCompany(userId);
    for (const ext of clearMirrorExternalIds) {
      const row = [...this.accountRows.values()].find((a) => a.userId === userId && a.externalId === ext);
      if (row) await this.clearMirror(row.id);
    }
  }

  async upsertAccount(connectionId: string, userId: string, a: AccountUpsert): Promise<AccountRow> {
    const prev = [...this.accountRows.values()].find((r) => r.connectionId === connectionId && r.externalId === a.externalId);
    const row: AccountRow = prev
      ? { ...prev, ...a }
      : { id: `${a.externalId}-row`, connectionId, userId, ...a, syncCursor: null, syncGeneration: 0, lastSyncedAt: null, lastSyncError: null, fullResyncAt: null };
    this.accountRows.set(row.id, row);
    this.assertOneCompany(userId);
    return row;
  }

  async updateAccountSync(accountId: string, patch: Partial<AccountRow>): Promise<void> {
    const row = this.accountRows.get(accountId);
    if (row) this.accountRows.set(accountId, { ...row, ...patch });
  }

  async deleteAccount(accountId: string): Promise<void> {
    this.accountRows.delete(accountId);
    this.mirror.delete(accountId);
    this.dismissed.delete(accountId);
  }

  async clearMirror(accountId: string): Promise<void> {
    this.mirror.delete(accountId);
    this.dismissed.delete(accountId);
    const row = this.accountRows.get(accountId);
    if (row) this.accountRows.set(accountId, { ...row, syncCursor: null, lastSyncedAt: null, fullResyncAt: null, syncGeneration: 0 });
  }

  async applyChangesPage(
    accountId: string,
    page: { upserts: MirrorExpenseInput[]; deletes: string[]; nextCursor: string; generation: number },
  ): Promise<'applied' | 'not_company'> {
    const row = this.accountRows.get(accountId);
    if (!row || row.label !== 'company' || this.connections.get(row.userId)?.status !== 'active') return 'not_company';
    const m = this.mirror.get(accountId) ?? new Map();
    for (const e of page.upserts) m.set(e.externalId, { ...e, accountId, syncGeneration: page.generation });
    for (const id of page.deletes) m.delete(id);
    this.mirror.set(accountId, m);
    this.accountRows.set(accountId, { ...row, syncCursor: page.nextCursor, syncGeneration: page.generation });
    return 'applied';
  }

  async sweepGeneration(accountId: string, generation: number): Promise<number> {
    const m = this.mirror.get(accountId);
    if (!m) return 0;
    let n = 0;
    for (const [id, e] of [...m]) if (e.syncGeneration < generation) { m.delete(id); n++; }
    return n;
  }

  async listMirrorExpenses(accountId: string, from: string, to: string): Promise<MirrorExpenseRow[]> {
    return this.expenses(accountId).filter((e) => e.date >= from && e.date <= to);
  }

  async findMirrorExpense(accountId: string, externalId: string): Promise<MirrorExpenseRow | null> {
    return this.mirror.get(accountId)?.get(externalId) ?? null;
  }

  async upsertMirrorExpense(accountId: string, e: MirrorExpenseInput): Promise<'applied' | 'not_company'> {
    const row = this.accountRows.get(accountId);
    if (!row || row.label !== 'company' || this.connections.get(row.userId)?.status !== 'active') return 'not_company';
    const m = this.mirror.get(accountId) ?? new Map();
    m.set(e.externalId, { ...e, accountId, syncGeneration: m.get(e.externalId)?.syncGeneration ?? 0 });
    this.mirror.set(accountId, m);
    return 'applied';
  }

  async deleteMirrorExpense(accountId: string, externalId: string): Promise<void> { this.mirror.get(accountId)?.delete(externalId); }

  async listDismissedIds(accountId: string): Promise<Set<string>> { return new Set(this.dismissed.get(accountId)?.keys() ?? []); }

  async addDismissal(accountId: string, externalExpenseId: string, reason: string | null): Promise<void> {
    const d = this.dismissed.get(accountId) ?? new Map();
    if (!d.has(externalExpenseId)) d.set(externalExpenseId, reason);
    this.dismissed.set(accountId, d);
  }
}
