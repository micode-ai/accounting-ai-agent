import { createHash } from 'crypto';
import type { RedisLike } from '../../lib/redis';
import type { CryptoService } from '../crypto.service';
import type { AiBudgetApiClient } from './ai-budget-api.client';
import type { PublicExpenseWire, RemoteCategory } from './ai-budget.types';

export const LIVE_CACHE_TTL_SECONDS = 300;
export const LIVE_MAX_PAGES = 10; // x limit 200
const PAGE_LIMIT = 200;

/** No text `search`: chat text filters are applied locally (merchant + description), never sent to AI Budget. */
export interface LiveExpenseFilter { dateFrom: string; dateTo: string; categoryId?: string }
interface LiveAccount { id: string; externalId: string }

const versionKey = (userId: string, accountRowId: string): string => `aib:live:ver:${userId}:${accountRowId}`;

/**
 * Live reads of non-company accounts. Private and other-business data is never stored in the DB: it lives in
 * Redis only as ciphertext (cryptoService) for at most 300 s. Nothing from a payload is ever logged here.
 */
export class AiBudgetLiveReadService {
  constructor(
    private readonly api: AiBudgetApiClient,
    private readonly redis: RedisLike,
    private readonly crypto: CryptoService,
  ) {}

  async listExpenses(
    userId: string,
    account: LiveAccount,
    f: LiveExpenseFilter,
  ): Promise<{ expenses: PublicExpenseWire[]; truncated: boolean }> {
    const filter = { dateFrom: f.dateFrom, dateTo: f.dateTo, categoryId: f.categoryId ?? null };
    return this.cached(userId, account, filter, async () => {
      const expenses: PublicExpenseWire[] = [];
      let cursor: string | undefined;
      let hasMore = false;
      for (let page = 0; page < LIVE_MAX_PAGES; page++) {
        const res = await this.api.listExpenses(userId, account.externalId, {
          date_from: f.dateFrom, date_to: f.dateTo,
          ...(f.categoryId ? { category_id: f.categoryId } : {}),
          limit: PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        });
        expenses.push(...res.data);
        hasMore = res.has_more && !!res.next_cursor;
        if (!hasMore) break;
        cursor = res.next_cursor as string;
      }
      return { expenses, truncated: hasMore };
    });
  }

  async listCategories(userId: string, account: LiveAccount): Promise<RemoteCategory[]> {
    return this.cached(userId, account, { kind: 'categories' }, () => this.api.listCategories(userId, account.externalId));
  }

  /** Bumps the version so every cached read of this account misses; the stale entries expire on their own. */
  async invalidate(userId: string, accountRowId: string): Promise<void> {
    await this.redis.incr(versionKey(userId, accountRowId));
  }

  private async cached<T>(userId: string, account: LiveAccount, filter: Record<string, unknown>, load: () => Promise<T>): Promise<T> {
    let key: string | null = null;
    try {
      const version = (await this.redis.get(versionKey(userId, account.id))) ?? '0';
      const sorted = Object.fromEntries(Object.entries(filter).sort(([a], [b]) => a.localeCompare(b)));
      const hash = createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
      key = `aib:live:${userId}:${account.id}:${version}:${hash}`;
      const hit = await this.redis.get(key);
      if (hit) {
        try {
          return JSON.parse(this.crypto.decryptFromString(hit)) as T;
        } catch {
          // Undecryptable or corrupt entry: treated as a miss and replaced below.
        }
      }
    } catch {
      key = null; // Redis unavailable: read live, do not cache.
    }

    const value = await load();
    if (key) {
      try {
        await this.redis.setEx(key, LIVE_CACHE_TTL_SECONDS, this.crypto.encryptToString(JSON.stringify(value)));
      } catch {
        // A cache write failure never fails the read.
      }
    }
    return value;
  }
}
