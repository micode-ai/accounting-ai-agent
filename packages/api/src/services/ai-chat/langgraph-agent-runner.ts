import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';
import { StateGraph, MessagesAnnotation, START, END } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { logger } from '../../utils/logger';
import { WFirmaCacheService } from '../wfirma-cache.service';
import { FileStorageService } from '../file-storage.service';
import { WFirmaServiceFactory } from '../wfirma-integration.factory';
import { CredentialsService } from '../credentials.service';
import { subscriptionService } from '../subscription.instance';
import { hrService } from '../hr/hr.instance';
import { ksefService } from '../ksef/ksef.instance';
import { ksefContractorService } from '../ksef/contractor.instance';
import { companyEnrichmentService } from '../company-enrichment.instance';
import {
  LLMProvider,
  ChatMessage,
  DEFAULT_LLM_CONFIG,
  Locale,
} from '../../types/ai-chat.types';
import { getSystemPrompt } from './constants';
import { detectLocale } from './utils';
import { createAllTools } from './tools';
import { AIMemoryService } from '../ai-memory/ai-memory.service';
import type { AiBudgetChatBinding, AiBudgetChatFactory } from '../ai-budget/ai-budget-chat.factory';
import type { Client as LangSmithClient } from 'langsmith';
import { redactingTracerCallbacks } from './trace-redaction';

export interface AgentRunResult {
  response: string;
  toolsUsed: string[];
  actualProvider: LLMProvider;
  actualModel: string;
  locale: Locale;
  /** True when an AI Budget tool put private or other-business data into this run. */
  aiBudgetNonCompanyDataUsed: boolean;
}

export class LangGraphAgentRunner {
  constructor(
    private readonly credentialsService: CredentialsService,
    private readonly wfirmaFactory: WFirmaServiceFactory,
    private readonly cacheService: WFirmaCacheService,
    private readonly fileStorageService: FileStorageService,
    private readonly memoryService?: AIMemoryService,
    private readonly aiBudgetFactory: AiBudgetChatFactory | null = null
  ) {}

  async run(
    existingMessages: ChatMessage[],
    userMessage: string,
    userId: string,
    conversationId: string,
    _provider: LLMProvider,
    options: {
      isShared?: boolean;
      /** A binding made beforehand with `bindAiBudget` (the caller needs it to decide trace privacy). */
      aiBudget?: AiBudgetChatBinding | null;
      /** The trace client of the caller's root run; the LangGraph tracer is bound to it. */
      traceClient?: LangSmithClient;
    } = {}
  ): Promise<AgentRunResult> {
    const userCreds = await this.credentialsService.getLLMCredentials(userId);
    if (!userCreds?.apiKey) {
      throw new Error('No LLM API key configured. Please add your API key in Settings → API Credentials.');
    }

    const { provider: selectedProvider, apiKey, model: selectedModel } = userCreds;

    logger.debug('Using user-specific LLM credentials from database', {
      userId,
      provider: selectedProvider,
      model: selectedModel,
    });

    const model = LangGraphAgentRunner.createModel(selectedProvider, apiKey, selectedModel);

    const wfirmaService = await this.wfirmaFactory.getServiceForUser(userId);

    const locale = detectLocale(userMessage);

    let memoryContext: string | undefined;
    if (this.memoryService) {
      try {
        memoryContext = await this.memoryService.buildMemoryPromptFragment(userId, locale);
      } catch (err) {
        logger.warn('Failed to load memory context', { err, userId });
      }
    }

    const aiBudget = options.aiBudget !== undefined
      ? options.aiBudget
      : await this.bindAiBudget(userId, userMessage, options.isShared === true);

    const systemPrompt = getSystemPrompt(locale, memoryContext, aiBudget ? [aiBudget.promptFragment] : undefined);
    const tools = [
      ...createAllTools(
        wfirmaService,
        this.cacheService,
        companyEnrichmentService,
        this.fileStorageService,
        userId,
        locale,
        subscriptionService,
        hrService,
        ksefService,
        ksefContractorService
      ),
      ...(aiBudget?.tools ?? []),
    ];

    logger.info('Created tools for agent', {
      toolCount: tools.length,
      toolNames: tools.map(t => t.name),
      locale,
    });

    const modelWithTools = model.bindTools(tools);
    // handleToolErrors is explicit; it is already the default in langgraph 0.2.x — keep it so the intent
    // survives upgrades: a tool that rejects its arguments (zod) answers with an error message the model
    // can correct, instead of crashing the run.
    const toolNode = new ToolNode(tools, { handleToolErrors: true });

    const callModel = async (state: typeof MessagesAnnotation.State) => {
      const response = await modelWithTools.invoke(state.messages);
      logger.debug('Model response', {
        hasToolCalls: !!(response.tool_calls && response.tool_calls.length > 0),
        toolCallsCount: response.tool_calls?.length || 0,
        contentLength: typeof response.content === 'string' ? response.content.length : 0,
      });
      return { messages: [response] };
    };

    const workflow = new StateGraph(MessagesAnnotation)
      .addNode('agent', callModel)
      .addNode('tools', toolNode)
      .addEdge(START, 'agent')
      .addConditionalEdges('agent', LangGraphAgentRunner.shouldContinue, ['tools', END])
      .addEdge('tools', 'agent');

    const graph = workflow.compile();

    const langchainMessages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
      ...existingMessages.map(msg => {
        if (msg.role === 'user') return new HumanMessage(msg.content);
        if (msg.role === 'assistant') return new AIMessage(msg.content);
        return new HumanMessage(msg.content);
      }),
      new HumanMessage(userMessage),
    ];

    const result = await graph.invoke(
      { messages: langchainMessages },
      {
        recursionLimit: 25,
        metadata: { conversationId, userId },
        tags: [`conv:${conversationId}`, `user:${userId}`],
        callbacks: redactingTracerCallbacks(options.traceClient),
      }
    );

    const toolsUsed: string[] = [];
    let finalResponse = '';

    for (const message of result.messages) {
      if (message instanceof AIMessage) {
        if (message.tool_calls?.length) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          toolsUsed.push(...message.tool_calls.map((tc: any) => tc.name));
        }
        if (message.content) {
          if (typeof message.content === 'string') {
            finalResponse = message.content;
          } else if (Array.isArray(message.content)) {
            const text = message.content
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .filter((b: any) => b.type === 'text')
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .map((b: any) => b.text)
              .join('');
            if (text) finalResponse = text;
          }
        }
      }
    }

    return {
      response: finalResponse,
      toolsUsed: [...new Set(toolsUsed)],
      actualProvider: selectedProvider,
      actualModel: selectedModel || DEFAULT_LLM_CONFIG[selectedProvider].model,
      locale,
      aiBudgetNonCompanyDataUsed: aiBudget?.nonCompanyDataUsed() ?? false,
    };
  }

  /**
   * The optional AI Budget tool group for one run, or null. A shared conversation gets the company-only
   * scope. A failure here never breaks the chat: the run simply goes without the group. A user with no LLM
   * key gets null without any AI Budget call: the run itself then refuses with the usual error.
   */
  async bindAiBudget(userId: string, userMessage: string, isShared: boolean): Promise<AiBudgetChatBinding | null> {
    if (!this.aiBudgetFactory) return null;
    try {
      const creds = await this.credentialsService.getLLMCredentials(userId);
      if (!creds?.apiKey) return null;
      return await this.aiBudgetFactory.forRun(userId, detectLocale(userMessage), { isShared });
    } catch (err) {
      logger.warn('Failed to bind AI Budget tools', { userId, error: (err as Error)?.name ?? 'unknown' });
      return null;
    }
  }

  /**
   * Create the LLM model based on provider.
   * Exported as static so it can be unit-tested without a full runner instance.
   */
  static createModel(provider: LLMProvider, apiKey: string, model?: string) {
    if (!apiKey) {
      throw new Error(`No API key provided for provider: ${provider}`);
    }

    const config = DEFAULT_LLM_CONFIG[provider];
    const modelToUse = model || config.model;

    if (provider === 'google') {
      return new ChatGoogleGenerativeAI({
        model: modelToUse,
        maxOutputTokens: config.maxTokens,
        temperature: config.temperature,
        apiKey,
      });
    }

    // Newer OpenAI models only accept temperature=1 and use max_completion_tokens
    const isNewerModel =
      modelToUse.startsWith('gpt-5') ||
      modelToUse.startsWith('o1') ||
      modelToUse.startsWith('o3');

    if (isNewerModel) {
      return new ChatOpenAI({ modelName: modelToUse, openAIApiKey: apiKey });
    }

    return new ChatOpenAI({
      modelName: modelToUse,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      openAIApiKey: apiKey,
    });
  }

  /**
   * LangGraph router: continue to tools if the last AI message has tool calls.
   * Exported as static so it can be unit-tested without a full runner instance.
   */
  static shouldContinue(state: typeof MessagesAnnotation.State): 'tools' | typeof END {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    if (last?.tool_calls?.length) return 'tools';
    return END;
  }
}
