/**
 * Dashboard Routes
 * Aggregated KPI endpoint for the main dashboard
 */

import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { dashboardService } from '../services/dashboard/dashboard.instance';
import { logger } from '../utils/logger';
import { aiBudget } from '../services/ai-budget';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * GET /api/dashboard/summary
 * Returns aggregated KPI data from all sources
 */
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const summary = await dashboardService.getSummary(userId);
    return res.status(200).json({ success: true, data: summary });
  } catch (error) {
    logger.error('Failed to fetch dashboard summary', { error });
    return res.status(500).json({ success: false, error: 'Failed to fetch dashboard summary' });
  }
});

/**
 * GET /api/dashboard/ai-budget
 * Company section from the AI Budget mirror. { state: 'unavailable' } when the integration is not configured.
 */
router.get('/ai-budget', async (req: Request, res: Response) => {
  // Company figures and account names: never kept in a browser or proxy cache.
  res.setHeader('Cache-Control', 'no-store');
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!aiBudget) return res.status(200).json({ success: true, data: { state: 'unavailable' } });
    return res.status(200).json({ success: true, data: await aiBudget.dashboard.getCompany(userId) });
  } catch (error) {
    logger.error('Failed to fetch AI Budget dashboard', { error: (error as Error)?.name });
    return res.status(500).json({ success: false, error: 'Failed to fetch AI Budget dashboard' });
  }
});

/**
 * GET /api/dashboard/personal
 * Private AI Budget accounts, read live (never stored). Per user, independent of the organization context.
 */
router.get('/personal', async (req: Request, res: Response) => {
  // Private figures: never kept in a browser or proxy cache.
  res.setHeader('Cache-Control', 'no-store');
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!aiBudget) return res.status(200).json({ success: true, data: { state: 'unavailable' } });
    return res.status(200).json({ success: true, data: await aiBudget.dashboard.getPersonal(userId) });
  } catch (error) {
    logger.error('Failed to fetch personal dashboard', { error: (error as Error)?.name });
    return res.status(500).json({ success: false, error: 'Failed to fetch personal dashboard' });
  }
});

export default router;
