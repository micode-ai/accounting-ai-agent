import { logger } from '../../utils/logger';
import type { RedisLike } from '../../lib/redis';
import type { AiBudgetRepository } from './ai-budget.repository';
import type { AiBudgetAccountsService } from './ai-budget-accounts.service';
import type { AiBudgetMirrorSyncService } from './ai-budget-sync.service';

export const SYNC_INTERVAL_MS = 15 * 60 * 1000;
export const RECONNECT_RETENTION_MS = 30 * 24 * 3600_000;
/** Shorter than the interval, so a crashed holder never blocks more than one tick. */
const TICK_LOCK_TTL_MS = 14 * 60 * 1000;
const TICK_LOCK_KEY = 'aib:job:tick';

export interface AiBudgetSyncJobDeps {
  repo: AiBudgetRepository;
  accounts: Pick<AiBudgetAccountsService, 'syncAccountList'>;
  sync: Pick<AiBudgetMirrorSyncService, 'syncCompany'>;
  redis: Pick<RedisLike, 'setNxPx'>;
}

const errName = (err: unknown): string => (err as Error)?.name ?? 'unknown';

/** Every 15 minutes: refresh each active connection's account list, sync its company mirror; drop stale mirrors. */
export class AiBudgetSyncJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: AiBudgetSyncJobDeps, private readonly now: () => Date = () => new Date()) {}

  start(): void {
    const run = (): void => {
      this.tick().catch((err) => logger.error('[AiBudgetSync] Tick error', { error: errName(err) }));
    };
    run();
    this.timer = setInterval(run, SYNC_INTERVAL_MS);
    logger.info('[AiBudgetSync] Sync job started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // One process at a time across API instances. Not released on purpose: the TTL (< interval) spaces ticks.
      if (!(await this.deps.redis.setNxPx(TICK_LOCK_KEY, '1', TICK_LOCK_TTL_MS))) return;
      await this.syncActive();
      await this.cleanupStale();
    } finally {
      this.running = false;
    }
  }

  private async syncActive(): Promise<void> {
    const { repo, accounts, sync } = this.deps;
    const connections = await repo.listActiveConnections();
    for (const conn of connections) {
      // The account-ids listener fires once per token refresh only, so the list is re-synced here.
      try {
        await accounts.syncAccountList(conn.userId);
      } catch (err) {
        logger.warn('[AiBudgetSync] Account list refresh failed', { userId: conn.userId, error: errName(err) });
      }
      try {
        await sync.syncCompany(conn.userId);
      } catch (err) {
        logger.warn('[AiBudgetSync] Company sync failed', { userId: conn.userId, error: errName(err) });
      }
    }
  }

  private async cleanupStale(): Promise<void> {
    const { repo } = this.deps;
    const cutoff = new Date(this.now().getTime() - RECONNECT_RETENTION_MS);
    const stale = await repo.listReconnectOlderThan(cutoff);
    for (const conn of stale) {
      try {
        for (const account of await repo.listAccounts(conn.userId)) await repo.clearMirror(account.id);
      } catch (err) {
        logger.warn('[AiBudgetSync] Mirror cleanup failed', { userId: conn.userId, error: errName(err) });
      }
    }
  }
}
