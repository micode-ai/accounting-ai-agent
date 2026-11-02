import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Locale } from '../../i18n';
import { SHARED_FRAGMENTS } from '../ai-chat/prompt-fragments';
import { createAiBudgetTools, type AiBudgetToolScope } from '../ai-chat/tools/ai-budget.tools';
import type { AiBudgetRepository } from './ai-budget.repository';
import type { AiBudgetServices } from './ai-budget.instance';
import { AiBudgetExpensesService } from './ai-budget-expenses.service';

export interface AiBudgetChatBinding {
  tools: StructuredToolInterface[];
  promptFragment: string;
  /** True once a tool of this run put private or other-business data into the conversation. */
  nonCompanyDataUsed(): boolean;
}

export type AiBudgetChatFactoryDeps = Pick<AiBudgetServices, 'repo' | 'accounts' | 'reconciliation' | 'sync' | 'live' | 'api'>;

/**
 * Builds the AI Budget tool group for one agent run. Pass `null` when the integration is not configured
 * (`aiBudget` from ai-budget.instance): the feature is hidden and no run gets tools.
 */
export class AiBudgetChatFactory {
  private readonly expenses: AiBudgetExpensesService | null;

  constructor(private readonly deps: AiBudgetChatFactoryDeps | null) {
    this.expenses = deps
      ? new AiBudgetExpensesService({ repo: deps.repo, accounts: deps.accounts, sync: deps.sync, live: deps.live, api: deps.api, reconciliation: deps.reconciliation })
      : null;
  }

  /**
   * null: integration unavailable, no connection, or revoked. A shared conversation gets the company-only
   * scope; a non-shared chat and Telegram see every account. A needs_reconnect connection still binds the
   * group, so every tool answers with the reconnect message instead of stale figures.
   */
  async forRun(userId: string, locale: Locale, opts: { isShared: boolean }): Promise<AiBudgetChatBinding | null> {
    if (!this.deps || !this.expenses) return null;
    const conn = await this.deps.repo.getConnection(userId);
    if (!conn || conn.status === 'revoked') return null;

    const status = conn.status === 'needs_reconnect' ? 'needs_reconnect' : 'active';
    const scope: AiBudgetToolScope = opts.isShared ? 'company_only' : 'all';
    // Read once per run. Writes re-read the accounts (and re-check the company-only scope) in the service.
    const accounts = await this.deps.repo.listAccounts(userId);
    const real = this.deps.repo;
    const runRepo: AiBudgetRepository = Object.assign(Object.create(real) as AiBudgetRepository, {
      listAccounts: async (u: string) => (u === userId ? accounts : real.listAccounts(u)),
    });

    let nonCompany = false;
    const tools = createAiBudgetTools({
      userId, locale, scope, connectionStatus: status, expenses: this.expenses, accounts: this.deps.accounts,
      reconciliation: this.deps.reconciliation, repo: runRepo, onNonCompanyData: () => { nonCompany = true; },
    });
    return { tools, promptFragment: SHARED_FRAGMENTS.aiBudgetRules(scope, status), nonCompanyDataUsed: () => nonCompany };
  }
}
