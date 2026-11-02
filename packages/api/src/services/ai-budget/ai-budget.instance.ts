import { prisma } from '../../lib/prisma';
import { redis, type RedisLike } from '../../lib/redis';
import { logger } from '../../utils/logger';
import { cryptoService } from '../crypto.instance';
import { wfirmaServiceFactory } from '../wfirma-integration-factory.instance';
import type { WFirmaServiceFactory } from '../wfirma-integration.factory';
import type { CryptoService } from '../crypto.service';
import { getAiBudgetConfig, type AiBudgetConfig } from './ai-budget.config';
import { PrismaAiBudgetRepository, type AiBudgetRepository } from './ai-budget.repository';
import { AiBudgetAccountsService } from './ai-budget-accounts.service';
import { AiBudgetDashboardService } from './ai-budget-dashboard.service';
import { AiBudgetApiClient } from './ai-budget-api.client';
import { AiBudgetLiveReadService } from './ai-budget-live.service';
import { AiBudgetReconciliationService } from './ai-budget-reconciliation.service';
import { AiBudgetOAuthClient } from './ai-budget-oauth.client';
import { AiBudgetOAuthService } from './ai-budget-oauth.service';
import { AiBudgetMirrorSyncService } from './ai-budget-sync.service';
import { AiBudgetTokenManager } from './ai-budget-token.manager';
import { createAxiosTransport, type AiBudgetTransport } from './ai-budget-transport';

export interface AiBudgetServices {
  config: AiBudgetConfig;
  repo: AiBudgetRepository;
  tokens: AiBudgetTokenManager;
  api: AiBudgetApiClient;
  accounts: AiBudgetAccountsService;
  live: AiBudgetLiveReadService;
  sync: AiBudgetMirrorSyncService;
  oauth: AiBudgetOAuthService;
  reconciliation: AiBudgetReconciliationService;
  dashboard: AiBudgetDashboardService;
}

/** Builds and wires the integration's services. Exported for tests; the app uses `aiBudget`. */
export function buildAiBudget(
  config: AiBudgetConfig,
  deps: { repo: AiBudgetRepository; redis: RedisLike; crypto: CryptoService; transport: AiBudgetTransport; wfirma: WFirmaServiceFactory },
): AiBudgetServices {
  const { repo, crypto, transport } = deps;
  const oauthClient = new AiBudgetOAuthClient(config, transport);
  const tokens = new AiBudgetTokenManager(repo, crypto, deps.redis, oauthClient);
  const api = new AiBudgetApiClient(config, transport, tokens);
  const live = new AiBudgetLiveReadService(api, deps.redis, crypto);
  const accounts = new AiBudgetAccountsService(repo, api, live);
  const sync = new AiBudgetMirrorSyncService(repo, accounts, api, deps.redis);

  // account_ids in a token response is authoritative: a differing set re-syncs the account list.
  tokens.setAccountIdsListener((userId, accountIds) => accounts.handleAccountIds(userId, accountIds));
  // A 403 that concerns one account (not granted / grant inactive / encrypted).
  api.setAccountAccessListener((userId, accountExternalId, code) => accounts.handleAccessError(userId, accountExternalId, code));
  // A new company account starts from a full resync of its mirror.
  accounts.setCompanyChangedListener((userId) => {
    void sync.syncCompany(userId, { fullResync: true }).catch((err: unknown) => {
      logger.warn('AI Budget resync after company change failed', { userId, error: (err as Error)?.name ?? 'unknown' });
    });
  });

  const oauth = new AiBudgetOAuthService(config, { redis: deps.redis, oauth: oauthClient, tokens, crypto, accounts, sync, repo, live });
  const reconciliation = new AiBudgetReconciliationService(repo, accounts, deps.wfirma, deps.redis);
  const dashboard = new AiBudgetDashboardService({ repo, accounts, sync, live, reconciliation, redis: deps.redis });
  return { config, repo, tokens, api, accounts, live, sync, oauth, reconciliation, dashboard };
}

const config = getAiBudgetConfig();

/** null when the integration is not configured: the feature is hidden. */
export const aiBudget: AiBudgetServices | null = config
  ? buildAiBudget(config, { repo: new PrismaAiBudgetRepository(prisma), redis, crypto: cryptoService, transport: createAxiosTransport(), wfirma: wfirmaServiceFactory })
  : null;
