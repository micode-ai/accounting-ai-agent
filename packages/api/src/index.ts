// IMPORTANT: Load environment variables FIRST before any other imports
import './config/env';

// IMPORTANT: Initialize Sentry BEFORE any other imports that may throw at boot
import { initSentry, Sentry } from './lib/sentry';
initSentry();

// LangSmith traces never carry AI Budget data: install the redacting client before any chat runs.
import { installTraceRedaction } from './services/ai-chat/trace-redaction';
installTraceRedaction();

import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { APP_VERSION } from './lib/version';
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import credentialsRoutes from './routes/credentials.routes';
import aiChatRoutes from './routes/ai-chat.routes';
import aiCostsRoutes from './routes/ai-costs.routes';
import fileRoutes from './routes/file.routes';
import helpRoutes from './routes/help.routes';
import adminRoutes from './routes/admin.routes';
import subscriptionRoutes from './routes/subscription.routes';
import webhookRoutes from './routes/webhook.routes';
import ttsRoutes from './routes/tts.routes';
import hrRoutes from './routes/hr.routes';
import ksefRoutes from './routes/ksef.routes';
import dashboardRoutes from './routes/dashboard.routes';
import aiMemoryRoutes from './routes/ai-memory.routes';
import organizationRoutes from './routes/organization.routes';
import referralRoutes from './routes/referral.routes';
import telegramBotRoutes from './routes/telegram-bot.routes';
import taxCalendarRoutes from './routes/tax-calendar.routes';
import promptShortcutRoutes from './routes/prompt-shortcut.routes';
import orgPromptShortcutRoutes from './routes/org-prompt-shortcut.routes';
import aiBudgetRoutes from './routes/ai-budget.routes';
import { aiBudget } from './services/ai-budget/ai-budget.instance';
import { AiBudgetSyncJob } from './services/ai-budget/ai-budget-sync.job';
import { redis } from './lib/redis';
import { telegramBotService, taxDeadlineReminderService } from './services/telegram-bot';
import { globalRateLimiter } from './middleware/rate-limiter.middleware';
import { auditLogMiddleware } from './middleware/audit-log.middleware';
import { errorHandler, notFoundHandler } from './middleware/error-handler.middleware';
import { logger } from './utils/logger';
import { seedHelpTopicsIfEmpty } from './services/help-seed.service';
import { ksefStatusPoller } from './services/ksef';
import { healthMonitorService } from './services/health';

const aiBudgetSyncJob = aiBudget ? new AiBudgetSyncJob({ repo: aiBudget.repo, accounts: aiBudget.accounts, sync: aiBudget.sync, redis }) : null;

const app: Application = express();
const PORT = process.env.PORT || 3011;

// CORS configuration - fail-secure in production
const corsOrigin = process.env.CORS_ORIGIN;
if (process.env.NODE_ENV === 'production' && !corsOrigin) {
  throw new Error(
    'SECURITY ERROR: CORS_ORIGIN must be set in production environment. ' +
    'Example: CORS_ORIGIN=https://yourdomain.com'
  );
}

// Middleware
app.use(helmet());
app.use(cors({
  origin: corsOrigin || 'http://localhost:3010',
  credentials: true, // Allow cookies for future httpOnly token migration
}));

// IMPORTANT: Webhook routes must be registered BEFORE express.json()
// because Stripe requires raw body for signature verification
app.use('/api/webhooks', webhookRoutes);

app.use(express.json({ limit: '100kb' })); // Prevent large payload attacks
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Global rate limiter
app.use('/api', globalRateLimiter);

// Audit log middleware (fire-and-forget, logs POST/PUT/PATCH/DELETE)
app.use('/api', auditLogMiddleware);

// Health check (full snapshot — used by frontend banner and uptime monitors)
app.get('/health', async (_req: Request, res: Response) => {
  const { healthService } = await import('./services/health');
  const snapshot = await healthService.getSnapshot();
  const code = snapshot.status === 'down' ? 503 : 200;
  res.status(code).json(snapshot);
});

// Liveness probe (no dependency checks — for k8s/docker)
app.get('/health/live', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

// API routes
app.get('/api', (_req: Request, res: Response) => {
  res.json({ message: 'Accounting AI Agent API', version: APP_VERSION });
});

// Auth routes
app.use('/api/auth', authRoutes);

// User routes
app.use('/api/users', userRoutes);

// Credentials routes
app.use('/api/credentials', credentialsRoutes);

// AI Chat routes
app.use('/api/ai', aiChatRoutes);

// AI Costs routes
app.use('/api/ai/costs', aiCostsRoutes);

// File download routes
app.use('/api/files', fileRoutes);

// Help routes (public - no authentication required)
app.use('/api/help', helpRoutes);

// Admin routes (admin role required)
app.use('/api/admin', adminRoutes);

// Subscription routes
app.use('/api/subscription', subscriptionRoutes);

// TTS routes (text-to-speech)
app.use('/api/tts', ttsRoutes);

// HR routes (employees, contracts, payroll, absences)
app.use('/api/hr', hrRoutes);

// KSeF routes (Polish National e-Invoice System)
app.use('/api/ksef', ksefRoutes);

// Dashboard routes (aggregated KPI data)
app.use('/api/dashboard', dashboardRoutes);

// AI Memory routes (context memory management)
app.use('/api/ai/memory', aiMemoryRoutes);

// Organization routes
app.use('/api/organization', organizationRoutes);

// Referral routes
app.use('/api/referral', referralRoutes);

// Telegram bot routes (account linking)
app.use('/api/telegram', telegramBotRoutes);

// Tax calendar routes (upcoming deadlines widget)
app.use('/api/tax-calendar', taxCalendarRoutes);

// Prompt shortcut routes (saved AI prompt shortcuts)
app.use('/api/ai/shortcuts', promptShortcutRoutes);

// Org shared prompt shortcuts (org admin manages, all members read)
app.use('/api/organization/shortcuts', orgPromptShortcutRoutes);

// AI Budget integration (OAuth connect/callback, status, labels, sync)
app.use('/api/integrations/ai-budget', aiBudgetRoutes);

// 404 handler
app.use(notFoundHandler);

// Sentry error handler must be registered BEFORE the application's error handler
// so it captures errors first, then the existing handler responds to the user.
Sentry.setupExpressErrorHandler(app);

// Global error handler
app.use(errorHandler);

// Start server
const server = app.listen(PORT, async () => {
  logger.info(`🚀 API Server running on port ${PORT}`);
  logger.info(`📝 Environment: ${process.env.NODE_ENV}`);

  // Auto-seed help topics if table is empty
  await seedHelpTopicsIfEmpty();

  // Start KSeF status poller for background invoice status updates
  ksefStatusPoller.start();

  // Start health monitor (periodic dependency snapshot + alerting)
  healthMonitorService.start();

  // Start tax deadline reminder service (proactive Telegram notifications)
  taxDeadlineReminderService.start();

  // AI Budget: 15-minute mirror sync + 30-day reconnect cleanup (only when the integration is configured)
  aiBudgetSyncJob?.start();

  // Start Telegram chatbot
  if (telegramBotService.isInitialized()) {
    const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

    if (webhookUrl && webhookSecret) {
      // Production: use webhook
      await telegramBotService.setupWebhook(webhookUrl, webhookSecret);
      const webhookCb = telegramBotService.getWebhookCallback(webhookSecret);
      if (webhookCb) {
        app.use('/api/telegram/webhook', webhookCb);
      }
      logger.info('[TelegramBot] Webhook mode enabled');
    } else {
      // Development: use polling
      await telegramBotService.startPolling();
      logger.info('[TelegramBot] Polling mode enabled');
    }
  }
});

// Graceful shutdown
const shutdown = () => {
  logger.info('Shutting down gracefully...');
  ksefStatusPoller.stop();
  healthMonitorService.stop();
  taxDeadlineReminderService.stop();
  aiBudgetSyncJob?.stop();
  telegramBotService.stop();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default app;
