import { Request, Response } from 'express';
import { aiBudget } from '../services/ai-budget/ai-budget.instance';
import { AiBudgetAccountNotFoundError, AiBudgetAccountUnavailableError } from '../services/ai-budget/ai-budget-errors';
import { toAccountDto } from '../services/ai-budget/ai-budget-oauth.service';
import type { AiBudgetLabel } from '../services/ai-budget/ai-budget.types';
import { logger } from '../utils/logger';

const unavailable = (res: Response): void => {
  res.status(503).json({ success: false, error: 'ai_budget_unavailable' });
};

const settingsUrl = (query: string): string =>
  `${(aiBudget?.config.frontendUrl ?? (process.env.FRONTEND_URL ?? '').trim()).replace(/\/+$/, '')}/settings/integrations?${query}`;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Errors are logged by name only: an AI Budget error carries a status and a code, never a token. */
const errName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown');

export class AiBudgetController {
  async getStatus(req: Request, res: Response): Promise<void> {
    const userId = req.user!.userId;
    if (!aiBudget) {
      res.status(200).json({ success: true, data: { available: false, connection: null } });
      return;
    }
    try {
      res.status(200).json({ success: true, data: await aiBudget.oauth.getStatus(userId) });
    } catch (err) {
      logger.error('AI Budget status failed', { userId, error: errName(err) });
      res.status(500).json({ success: false, error: 'Failed to load AI Budget status' });
    }
  }

  async startConnect(req: Request, res: Response): Promise<void> {
    if (!aiBudget) return unavailable(res);
    const userId = req.user!.userId;
    try {
      res.status(200).json({ success: true, data: await aiBudget.oauth.startConnect(userId) });
    } catch (err) {
      logger.error('AI Budget connect start failed', { userId, error: errName(err) });
      res.status(500).json({ success: false, error: 'Failed to start the AI Budget connection' });
    }
  }

  /**
   * Unauthenticated OAuth redirect target. It exchanges nothing: it forwards code and state to the web
   * app's completion page, which posts them to the authenticated `complete` route (Ruling 8).
   */
  async handleCallback(req: Request, res: Response): Promise<void> {
    // The query holds a one-time authorization code: never log it or let it be cached.
    res.setHeader('Cache-Control', 'no-store');
    let url: string;
    if (!aiBudget) {
      url = settingsUrl('ai_budget=error&reason=unavailable');
    } else {
      try {
        url = await aiBudget.oauth.handleCallback({ code: str(req.query.code), state: str(req.query.state), error: str(req.query.error) });
      } catch (err) {
        logger.error('AI Budget callback failed', { error: errName(err) });
        url = settingsUrl('ai_budget=error&reason=exchange_failed');
      }
    }
    res.redirect(302, url);
  }

  async complete(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    if (!aiBudget) return unavailable(res);
    const userId = req.user!.userId;
    const { code, state } = req.body as { code: string; state: string };
    try {
      const result = await aiBudget.oauth.completeConnect(userId, { code, state });
      if (result.ok) {
        res.status(200).json({ success: true, data: { connected: true } });
      } else {
        res.status(400).json({ success: false, error: result.reason });
      }
    } catch (err) {
      logger.error('AI Budget connect completion failed', { userId, error: errName(err) });
      res.status(500).json({ success: false, error: 'exchange_failed' });
    }
  }

  async disconnect(req: Request, res: Response): Promise<void> {
    if (!aiBudget) return unavailable(res);
    const userId = req.user!.userId;
    try {
      res.status(200).json({ success: true, data: await aiBudget.oauth.disconnect(userId) });
    } catch (err) {
      logger.error('AI Budget disconnect failed', { userId, error: errName(err) });
      res.status(500).json({ success: false, error: 'Failed to disconnect AI Budget' });
    }
  }

  async setLabel(req: Request, res: Response): Promise<void> {
    if (!aiBudget) return unavailable(res);
    const userId = req.user!.userId;
    const { accountId } = req.params;
    const label = req.body.label as AiBudgetLabel;
    try {
      const rows = await aiBudget.accounts.setLabel(userId, accountId, label);
      res.status(200).json({ success: true, data: { accounts: rows.map(toAccountDto) } });
    } catch (err) {
      // setLabel looks only among the caller's own rows: another user's row id is a 404.
      if (err instanceof AiBudgetAccountNotFoundError) {
        res.status(404).json({ success: false, error: 'account_not_found' });
        return;
      }
      if (err instanceof AiBudgetAccountUnavailableError) {
        res.status(409).json({ success: false, error: 'account_unavailable' });
        return;
      }
      logger.error('AI Budget label change failed', { userId, error: errName(err) });
      res.status(500).json({ success: false, error: 'Failed to change the account label' });
    }
  }

  async sync(req: Request, res: Response): Promise<void> {
    if (!aiBudget) return unavailable(res);
    const userId = req.user!.userId;
    void aiBudget.sync.syncCompany(userId).catch((err: unknown) => {
      logger.warn('AI Budget manual sync failed', { userId, error: errName(err) });
    });
    res.status(202).json({ success: true, data: { started: true } });
  }

  async dismissReconciliation(req: Request, res: Response): Promise<void> {
    if (!aiBudget) return unavailable(res);
    const userId = req.user!.userId;
    const { expenseId, reason } = req.body as { expenseId: string; reason?: string };
    try {
      const outcome = await aiBudget.reconciliation.dismiss(userId, expenseId, reason ?? null);
      if (outcome === 'no_company') {
        res.status(409).json({ success: false, error: 'no_company' });
        return;
      }
      if (outcome === 'not_found') {
        res.status(404).json({ success: false, error: 'expense_not_found' });
        return;
      }
      res.status(200).json({ success: true, data: { dismissed: true } });
    } catch (err) {
      logger.error('AI Budget reconciliation dismissal failed', { userId, error: errName(err) });
      res.status(500).json({ success: false, error: 'Failed to dismiss the item' });
    }
  }
}

export const aiBudgetController = new AiBudgetController();
