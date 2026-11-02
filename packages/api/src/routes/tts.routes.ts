/**
 * TTS Routes
 * API endpoints for text-to-speech synthesis
 * Tracks costs in database for reliable billing
 */

import { Router, Request, Response } from 'express';
import { traceable } from 'langsmith/traceable';
import { authenticate } from '../middleware/auth.middleware';
import { rateLimiter } from '../middleware/rate-limiter.middleware';
import { TTSVoice, TTSModel } from '../services/tts.service';
import { ttsService } from '../services/tts.instance';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { getTraceClient } from '../services/ai-chat/trace-redaction';
import { z } from 'zod';

// TTS pricing constants
const TTS_PRICING = {
  'tts-1': 0.015, // $0.015 per 1K characters
  'tts-1-hd': 0.030, // $0.030 per 1K characters
};

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * A speak request carries only text: it cannot be tied to a conversation. While the user has an AI Budget
 * connection, the text may restate private figures, so the trace is private (inputs/outputs blanked).
 * A failed lookup fails closed.
 */
async function ttsTraceIsPrivate(userId: string): Promise<boolean> {
  try {
    const conn = await prisma.aiBudgetConnection.findUnique({ where: { userId }, select: { status: true } });
    return !!conn && conn.status !== 'revoked';
  } catch {
    return true;
  }
}

// Validation schema for TTS request
const ttsRequestSchema = z.object({
  text: z.string().min(1).max(4096),
  voice: z
    .enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'])
    .optional()
    .default('nova'),
  model: z.enum(['tts-1', 'tts-1-hd']).optional().default('tts-1'),
});

/**
 * POST /api/tts/speak
 * Synthesize text to speech using OpenAI TTS
 */
router.post(
  '/speak',
  rateLimiter({ windowMs: 60 * 1000, max: 20 }), // 20 per minute
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.userId;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Validate request body
      const parsed = ttsRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid request',
          details: parsed.error.errors,
        });
      }

      const { text, voice, model } = parsed.data;

      // Calculate cost for LangSmith tracking
      const characterCount = text.length;
      const costPer1K = TTS_PRICING[model as keyof typeof TTS_PRICING] || TTS_PRICING['tts-1'];
      const estimatedCostUSD = (characterCount / 1000) * costPer1K;

      // Wrap synthesis in traceable for LangSmith visibility. Never the default client: the redacting one,
      // or the private one when AI Budget is connected. The audio itself never goes into the trace outputs.
      const traceClient = getTraceClient({ private: await ttsTraceIsPrivate(userId) });
      let audioBuffer: Buffer | undefined;
      const synthesizeWithTracing = traceable(
        async () => {
          audioBuffer = await ttsService.synthesize(userId, text, {
            voice: voice as TTSVoice,
            model: model as TTSModel,
          });
          // Return with usage info for LangSmith cost tracking
          return {
            usage: {
              characters: characterCount,
              cost_usd: parseFloat(estimatedCostUSD.toFixed(6)),
              model,
              voice,
            },
          };
        },
        {
          name: 'tts_manual_speak',
          ...(traceClient ? { client: traceClient } : {}),
          run_type: 'llm', // Use 'llm' type so LangSmith shows cost column
          metadata: {
            userId,
            voice,
            model,
            characters: characterCount,
            estimated_cost_usd: parseFloat(estimatedCostUSD.toFixed(6)),
            pricing: `$${costPer1K} per 1K characters`,
            source: 'manual_button',
          },
          tags: [`user:${userId}`], // Required for LangSmith cost dashboard queries
        }
      );

      await synthesizeWithTracing();
      if (!audioBuffer) throw new Error('TTS synthesis returned no audio');

      // Save TTS cost to database for reliable tracking
      try {
        await prisma.user.update({
          where: { id: userId },
          data: {
            ttsCharactersUsed: { increment: characterCount },
            ttsCostUsd: { increment: estimatedCostUSD },
          },
        });
        logger.debug('TTS cost saved to database', { userId, characters: characterCount, costUsd: estimatedCostUSD });
      } catch (dbError) {
        // Log but don't fail the TTS request if cost tracking fails
        logger.error('Failed to save TTS cost to database', {
          error: dbError instanceof Error ? dbError.message : dbError,
          userId,
        });
      }

      // Send audio response
      res.set({
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.length.toString(),
        'Cache-Control': 'no-cache',
      });

      return res.send(audioBuffer);
    } catch (error) {
      logger.error('TTS endpoint error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        userId: req.user?.userId,
      });

      const message = error instanceof Error ? error.message : 'TTS synthesis failed';

      // Specific error handling
      if (message.includes('API key not configured')) {
        return res.status(400).json({ error: 'OpenAI API key not configured' });
      }
      if (message.includes('requires OpenAI provider')) {
        return res.status(400).json({ error: message });
      }
      if (message.includes('Invalid OpenAI API key')) {
        return res.status(401).json({ error: 'Invalid OpenAI API key' });
      }
      if (message.includes('rate limit')) {
        return res.status(429).json({ error: message });
      }

      return res.status(500).json({ error: 'TTS synthesis failed' });
    }
  }
);

/**
 * GET /api/tts/status
 * Check if user can use TTS (has valid OpenAI credentials)
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const canUse = await ttsService.canUseTTS(userId);

    return res.json({
      available: canUse,
      voices: canUse
        ? ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']
        : [],
    });
  } catch (error) {
    logger.error('TTS status check failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.user?.userId,
    });

    return res.status(500).json({ error: 'Failed to check TTS status' });
  }
});

export default router;
