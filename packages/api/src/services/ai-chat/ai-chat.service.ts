/**
 * AI Chat Service
 * Thin orchestrator that delegates to ConversationRepository and LangGraphAgentRunner.
 */

import { AIConversation } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { traceable } from 'langsmith/traceable';
import { logger } from '../../utils/logger';
import {
  LLMProvider,
  ChatMessage,
  AIConversationData,
  ConversationListItem,
  ProcessMessageResult,
  TTSMetadata,
} from '../../types/ai-chat.types';
import { generateTitleFromMessage } from './utils';
import { TTSIntegration } from './tts-integration';
import { AIMemoryExtractionService } from '../ai-memory/memory-extraction.service';
import { ConversationRepository } from './conversation-repository';
import { LangGraphAgentRunner } from './langgraph-agent-runner';
import { getTraceClient, isTracingEnabled } from './trace-redaction';

export class AIChatService {
  constructor(
    private readonly repo: ConversationRepository,
    private readonly agentRunner: LangGraphAgentRunner,
    private readonly ttsIntegration: TTSIntegration,
    private readonly memoryExtractionService?: AIMemoryExtractionService
  ) {
    if (isTracingEnabled()) {
      logger.info('LangSmith tracing enabled');
    }
    logger.info('AIChatService initialized with LangGraph');
  }

  async createConversation(userId: string, title?: string): Promise<AIConversation> {
    return this.repo.create(userId, title);
  }

  /**
   * Send a message and get AI response using LangGraph.
   * Wrapped with traceable for full LangSmith visibility (including TTS).
   */
  async sendMessage(
    conversationId: string,
    userId: string,
    content: string,
    provider?: LLMProvider,
    /**
     * aiBudgetCompanyOnly: the answer goes to an audience other than the user (a Telegram group): AI Budget
     * gets the company-only scope even though the conversation itself is not shared.
     */
    options?: { ttsEnabled?: boolean; aiBudgetCompanyOnly?: boolean }
  ): Promise<ProcessMessageResult> {
    const conversation = await this.repo.findAuthorized(conversationId, userId);
    if (!conversation) throw new Error('Conversation not found');

    // Decided before the root run is posted (Ruling 12): the trace is private when the thread already holds
    // private AI Budget data, or this run sees every account (AI Budget tools bound outside a shared chat).
    // A private trace posts no inputs or outputs at all; child runs inherit the root's client.
    const companyOnly = conversation.isShared || options?.aiBudgetCompanyOnly === true;
    const aiBudget = await this.agentRunner.bindAiBudget(userId, content, companyOnly);
    const privateTrace = conversation.containsPrivateAiBudgetData || (aiBudget !== null && !companyOnly);
    const traceClient = getTraceClient({ private: privateTrace });

    const processMessage = traceable(
      async (): Promise<ProcessMessageResult> => {
        const startTime = Date.now();

        const existingMessages = (conversation.messages as any[]) as ChatMessage[];

        const userMessage: ChatMessage = {
          id: uuidv4(),
          role: 'user',
          content,
          timestamp: new Date(),
        };

        if (conversation.isShared) {
          const authorName = await this.repo.getUserDisplayName(userId);
          userMessage.authorId = userId;
          userMessage.authorName = authorName;
        }

        const { response, toolsUsed, actualProvider, actualModel, locale, aiBudgetNonCompanyDataUsed } =
          await this.agentRunner.run(
            existingMessages,
            content,
            userId,
            conversationId,
            provider || 'openai',
            { isShared: conversation.isShared, aiBudget, traceClient }
          );

        // Flag the thread before its content is saved, so private AI Budget data is never stored unflagged
        // (the share dialog warns on this flag).
        if (aiBudgetNonCompanyDataUsed) {
          await this.repo.markContainsPrivateAiBudgetData(conversationId);
        }

        const assistantMessage: ChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: response,
          timestamp: new Date(),
          metadata: { provider: actualProvider, model: actualModel },
        };

        const updatedMessages = [...existingMessages, userMessage, assistantMessage];
        const isFirstUserMessage = updatedMessages.filter(m => m.role === 'user').length === 1;
        const newTitle = isFirstUserMessage ? generateTitleFromMessage(content) : conversation.title;

        await this.repo.updateMessages(conversationId, updatedMessages, newTitle);

        logger.info('Message processed with LangGraph', {
          conversationId,
          userId,
          processingTimeMs: Date.now() - startTime,
          toolsUsed,
        });

        if (this.memoryExtractionService) {
          this.memoryExtractionService
            .extractFromConversation(userId, conversationId, content, response, toolsUsed, locale)
            .catch(err => logger.warn('Memory extraction failed', { err, conversationId }));
        }

        let tts: TTSMetadata | undefined;
        if (options?.ttsEnabled !== false) {
          try {
            tts = await this.ttsIntegration.generateForResponse(userId, response, locale);
          } catch (error) {
            logger.warn('TTS integration failed', { error, conversationId, userId });
          }
        }

        return { userMessage, assistantMessage, toolsUsed, tts };
      },
      {
        name: 'ai_chat_message',
        run_type: 'chain',
        client: traceClient,
        metadata: { conversationId, userId, provider: provider || 'openai' },
        tags: [`conv:${conversationId}`, `user:${userId}`],
      }
    );

    return processMessage();
  }

  async getConversations(userId: string, limit: number = 50, query?: string): Promise<ConversationListItem[]> {
    return this.repo.list(userId, limit, query);
  }

  async getConversation(conversationId: string, userId: string): Promise<AIConversationData | null> {
    return this.repo.getWithMessages(conversationId, userId);
  }

  async getSharedConversations(userId: string, limit: number = 50): Promise<ConversationListItem[]> {
    return this.repo.listShared(userId, limit);
  }

  async shareConversation(conversationId: string, userId: string): Promise<void> {
    return this.repo.share(conversationId, userId);
  }

  async unshareConversation(conversationId: string, userId: string): Promise<void> {
    return this.repo.unshare(conversationId, userId);
  }

  async deleteConversation(conversationId: string, userId: string): Promise<void> {
    return this.repo.softDelete(conversationId, userId);
  }
}
