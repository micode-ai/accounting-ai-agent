import { Router } from 'express';
import { z } from 'zod';
import { aiBudgetController } from '../controllers/ai-budget.controller';
import { authenticate } from '../middleware/auth.middleware';
import { rateLimiter } from '../middleware/rate-limiter.middleware';
import { validateRequest } from '../middleware/validation.middleware';

const setLabelSchema = z.object({
  params: z.object({ accountId: z.string().min(1).max(64) }),
  body: z.object({ label: z.enum(['company', 'other_business', 'private']) }),
});

const completeSchema = z.object({
  body: z.object({ code: z.string().min(1).max(512), state: z.string().min(1).max(64) }),
});

const dismissSchema = z.object({
  body: z.object({ expenseId: z.string().min(1).max(100), reason: z.string().max(200).optional() }),
});

const router = Router();

// Every response here concerns the user's AI Budget connection (account names, labels, sync state):
// never kept in a browser or proxy cache.
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// PUBLIC — AI Budget redirects the browser here; it only forwards code+state to the web app (no exchange).
router.get('/callback', aiBudgetController.handleCallback.bind(aiBudgetController));

// AUTHENTICATED
router.get('/status', authenticate, aiBudgetController.getStatus.bind(aiBudgetController));
router.post(
  '/connect',
  authenticate,
  rateLimiter({ windowMs: 15 * 60 * 1000, max: 10 }),
  aiBudgetController.startConnect.bind(aiBudgetController),
);
router.post(
  '/complete',
  authenticate,
  rateLimiter({ windowMs: 15 * 60 * 1000, max: 10 }),
  validateRequest(completeSchema),
  aiBudgetController.complete.bind(aiBudgetController),
);
router.post('/disconnect', authenticate, aiBudgetController.disconnect.bind(aiBudgetController));
router.patch(
  '/accounts/:accountId/label',
  authenticate,
  validateRequest(setLabelSchema),
  aiBudgetController.setLabel.bind(aiBudgetController),
);
router.post(
  '/sync',
  authenticate,
  rateLimiter({ windowMs: 60 * 1000, max: 6 }),
  aiBudgetController.sync.bind(aiBudgetController),
);

router.post(
  '/reconciliation/dismissals',
  authenticate,
  rateLimiter({ windowMs: 60 * 1000, max: 6 }),
  validateRequest(dismissSchema),
  aiBudgetController.dismissReconciliation.bind(aiBudgetController),
);

export default router;
