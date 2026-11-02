import { logger } from '../../utils/logger';
import type { AiBudgetApiClient } from './ai-budget-api.client';
import type { AiBudgetLiveReadService } from './ai-budget-live.service';
import { AiBudgetAccountNotFoundError, AiBudgetAccountUnavailableError, AiBudgetNotConnectedError } from './ai-budget-errors';
import { applyLabelChange, computeAutoLabels, type LabelState } from './ai-budget-labels';
import type { AccountRow, AiBudgetRepository } from './ai-budget.repository';
import type { AiBudgetLabel, RemoteAccount } from './ai-budget.types';

export interface AccountsSyncResult {
  accounts: AccountRow[];
  dropped: string[];
  needsCompanyChoice: boolean;
  companyChanged: boolean;
}

const toState = (a: AccountRow): LabelState => ({ externalId: a.externalId, type: a.type, label: a.label, labelSource: a.labelSource });
const companyOf = (rows: { externalId: string; label: AiBudgetLabel }[]): string | null =>
  rows.find((r) => r.label === 'company')?.externalId ?? null;

/**
 * An account whose name or type AI Budget hides (the grantor left the account) is unavailable:
 * inactive, never company (an account that is only inactive but visible keeps a prior company label, Ruling 7), name/type stored as '' so the UI can localize "unavailable".
 */
interface NormalizedAccount {
  externalId: string;
  name: string;
  type: string;
  currency: string;
  access: 'read' | 'read_write';
  active: boolean;
  inactiveReason: string | null;
  unavailable: boolean;
}

function normalize(r: RemoteAccount): NormalizedAccount {
  const unavailable = r.name === null || r.type === null;
  const active = r.active && !unavailable;
  return {
    externalId: r.id,
    name: r.name ?? '',
    type: unavailable ? '' : (r.type ?? ''),
    currency: r.base_currency ?? '',
    access: r.access,
    active,
    inactiveReason: active ? null : (r.reason ?? 'role'),
    unavailable,
  };
}

export class AiBudgetAccountsService {
  private companyChangedListener: ((userId: string) => void) | null = null;

  constructor(
    private readonly repo: AiBudgetRepository,
    private readonly api: AiBudgetApiClient,
    private readonly live?: Pick<AiBudgetLiveReadService, 'invalidate'>,
  ) {}

  setCompanyChangedListener(fn: (userId: string) => void): void {
    this.companyChangedListener = fn;
  }

  /**
   * Mirrors GET /accounts. Accounts that vanished are dropped with their mirror and dismissals; inactive
   * accounts keep their mirror. Manual labels win; the one-company rule is kept (demote before promote).
   */
  async syncAccountList(userId: string): Promise<AccountsSyncResult> {
    const conn = await this.repo.getConnection(userId);
    if (!conn || conn.status === 'revoked') throw new AiBudgetNotConnectedError();

    const remote = (await this.api.listAccounts(userId)).map(normalize);
    const before = await this.repo.listAccounts(userId);
    const remoteIds = new Set(remote.map((r) => r.externalId));

    const dropped = before.filter((a) => !remoteIds.has(a.externalId));
    for (const a of dropped) await this.repo.deleteAccount(a.id);
    const kept = before.filter((a) => remoteIds.has(a.externalId));

    const computed = computeAutoLabels(
      remote.map((r) => ({ externalId: r.externalId, type: r.type, active: r.active })),
      kept.map(toState),
    );
    const labels = computed.labels.map((l) => ({ externalId: l.externalId, label: l.label, labelSource: l.labelSource }));
    const needsCompanyChoice = computed.needsCompanyChoice;

    const priorByExternal = new Map(kept.map((a) => [a.externalId, a]));
    for (const r of remote) {
      const prior = priorByExternal.get(r.externalId);
      await this.repo.upsertAccount(conn.id, userId, {
        externalId: r.externalId, name: r.name, type: r.type, currency: r.currency, access: r.access,
        active: r.active, inactiveReason: r.inactiveReason,
        label: prior?.label ?? 'private', labelSource: prior?.labelSource ?? 'auto',
      });
    }
    const finalCompany = companyOf(labels);
    const leftCompany = kept.filter((a) => a.label === 'company' && a.externalId !== finalCompany).map((a) => a.externalId);
    await this.repo.replaceLabels(userId, labels, leftCompany);
    await this.repo.setNeedsCompanyChoice(userId, needsCompanyChoice);

    const companyChanged = companyOf(before) !== finalCompany;
    if (companyChanged) this.companyChangedListener?.(userId);
    return {
      accounts: await this.repo.listAccounts(userId),
      dropped: dropped.map((a) => a.externalId),
      needsCompanyChoice,
      companyChanged,
    };
  }

  async setLabel(userId: string, accountRowId: string, label: AiBudgetLabel): Promise<AccountRow[]> {
    const rows = await this.repo.listAccounts(userId);
    const target = rows.find((a) => a.id === accountRowId);
    if (!target) throw new AiBudgetAccountNotFoundError();
    if (label === 'company' && (!target.active || target.type === '')) throw new AiBudgetAccountUnavailableError();

    const current = rows.map(toState);
    const next = applyLabelChange(current, target.externalId, label);
    const changed = next.filter((n, i) => n.label !== current[i].label || n.labelSource !== current[i].labelSource);
    const leftCompany = rows
      .filter((row) => row.label === 'company' && next.find((x) => x.externalId === row.externalId)!.label !== 'company')
      .map((row) => row.externalId);
    await this.repo.replaceLabels(userId, changed.map((c) => ({ externalId: c.externalId, label: c.label, labelSource: c.labelSource })), leftCompany);
    // A relabelled account's cached live reads must not survive the change.
    for (const c of changed) {
      const row = rows.find((r) => r.externalId === c.externalId);
      if (row) await this.invalidateLive(userId, row.id);
    }

    const byExternal = new Map(rows.map((r) => [r.externalId, r]));
    const hasCompany = next.some((n) => n.label === 'company');
    const candidates = next.filter((n) => {
      const r = byExternal.get(n.externalId)!;
      return r.active && n.type === 'business' && !(n.labelSource === 'manual' && n.label !== 'company');
    });
    await this.repo.setNeedsCompanyChoice(userId, !hasCompany && candidates.length >= 2);

    if (companyOf(current) !== companyOf(next)) this.companyChangedListener?.(userId);
    return this.repo.listAccounts(userId);
  }

  private async invalidateLive(userId: string, accountRowId: string): Promise<void> {
    try {
      await this.live?.invalidate(userId, accountRowId);
    } catch {
      logger.warn('AI Budget live cache invalidation failed', { userId });
    }
  }

  async getCompanyAccount(userId: string): Promise<AccountRow | null> {
    return (await this.repo.listAccounts(userId)).find((a) => a.label === 'company' && a.active) ?? null;
  }

  /**
   * Wire to `AiBudgetTokenManager.setAccountIdsListener`: `account_ids` in a token response is
   * authoritative, so a differing set triggers a re-sync of the account list.
   */
  async handleAccountIds(userId: string, accountIds: string[]): Promise<void> {
    try {
      const stored = new Set((await this.repo.listAccounts(userId)).map((a) => a.externalId));
      const incoming = new Set(accountIds);
      const same = stored.size === incoming.size && [...incoming].every((id) => stored.has(id));
      if (!same) await this.syncAccountList(userId);
    } catch (err) {
      logger.warn('AI Budget account list re-sync after token response failed', { userId, error: (err as Error).name });
    }
  }

  /**
   * account_not_granted: the account is gone, re-sync (drops mirror, cursor, dismissals).
   * grant_inactive: keep the rows, mark the account inactive.
   * account_encrypted: the account is readable, only writes and merchant/search filters are
   * refused, so nothing changes here.
   */
  async handleAccessError(userId: string, accountExternalId: string, code: string): Promise<void> {
    if (code === 'account_not_granted') {
      await this.syncAccountList(userId);
      return;
    }
    if (code !== 'grant_inactive') return;
    const row = (await this.repo.listAccounts(userId)).find((a) => a.externalId === accountExternalId);
    if (!row) return;
    await this.repo.upsertAccount(row.connectionId, userId, {
      externalId: row.externalId, name: row.name, type: row.type, currency: row.currency, access: row.access,
      active: false, inactiveReason: 'grant_inactive', label: row.label, labelSource: row.labelSource,
    });
  }
}
