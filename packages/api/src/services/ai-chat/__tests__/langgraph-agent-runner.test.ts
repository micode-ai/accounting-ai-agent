import { AIMessage } from '@langchain/core/messages';
import { END } from '@langchain/langgraph';
import { LangGraphAgentRunner } from '../langgraph-agent-runner';

// Mock heavy LangChain/OpenAI dependencies so this runs without real API keys
jest.mock('@langchain/openai', () => ({
  ChatOpenAI: jest.fn().mockImplementation((opts: Record<string, unknown>) => ({ _type: 'openai', opts })),
}));
jest.mock('@langchain/google-genai', () => ({
  ChatGoogleGenerativeAI: jest.fn().mockImplementation((opts: Record<string, unknown>) => ({ _type: 'google', opts })),
}));

const { ChatOpenAI } = require('@langchain/openai');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');

describe('LangGraphAgentRunner.createModel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a ChatOpenAI instance for openai provider', () => {
    const model = LangGraphAgentRunner.createModel('openai', 'sk-test');
    expect(ChatOpenAI).toHaveBeenCalledTimes(1);
    expect(ChatGoogleGenerativeAI).not.toHaveBeenCalled();
    expect(model).toBeDefined();
  });

  it('creates a ChatGoogleGenerativeAI instance for google provider', () => {
    const model = LangGraphAgentRunner.createModel('google', 'goog-key');
    expect(ChatGoogleGenerativeAI).toHaveBeenCalledTimes(1);
    expect(ChatOpenAI).not.toHaveBeenCalled();
    expect(model).toBeDefined();
  });

  it('passes the custom model name through', () => {
    LangGraphAgentRunner.createModel('openai', 'sk-test', 'gpt-4-turbo');
    const [callArgs] = ChatOpenAI.mock.calls[0];
    expect(callArgs.modelName).toBe('gpt-4-turbo');
  });

  it('omits temperature and maxTokens for newer OpenAI models (o1)', () => {
    LangGraphAgentRunner.createModel('openai', 'sk-test', 'o1-mini');
    const [callArgs] = ChatOpenAI.mock.calls[0];
    expect(callArgs.temperature).toBeUndefined();
    expect(callArgs.maxTokens).toBeUndefined();
  });

  it('omits temperature and maxTokens for newer OpenAI models (o3)', () => {
    LangGraphAgentRunner.createModel('openai', 'sk-test', 'o3-mini');
    const [callArgs] = ChatOpenAI.mock.calls[0];
    expect(callArgs.temperature).toBeUndefined();
    expect(callArgs.maxTokens).toBeUndefined();
  });

  it('sets temperature and maxTokens for standard gpt-4o model', () => {
    LangGraphAgentRunner.createModel('openai', 'sk-test', 'gpt-4o');
    const [callArgs] = ChatOpenAI.mock.calls[0];
    expect(callArgs.temperature).toBeDefined();
    expect(callArgs.maxTokens).toBeDefined();
  });

  it('throws when apiKey is empty string', () => {
    expect(() => LangGraphAgentRunner.createModel('openai', '')).toThrow(
      'No API key provided for provider: openai'
    );
  });
});

describe('LangGraphAgentRunner.shouldContinue', () => {
  const makeState = (toolCalls: unknown[] | undefined) => ({
    messages: [
      {
        tool_calls: toolCalls,
      } as unknown as AIMessage,
    ],
  });

  it('returns "tools" when the last message has tool_calls', () => {
    const state = makeState([{ name: 'get_invoices', args: {} }]);
    expect(LangGraphAgentRunner.shouldContinue(state as any)).toBe('tools');
  });

  it('returns END when the last message has no tool_calls', () => {
    const state = makeState(undefined);
    expect(LangGraphAgentRunner.shouldContinue(state as any)).toBe(END);
  });

  it('returns END when tool_calls is an empty array', () => {
    const state = makeState([]);
    expect(LangGraphAgentRunner.shouldContinue(state as any)).toBe(END);
  });
});

// ---------------------------------------------------------------------------
// AI Budget tool group wiring (Task 13)
// ---------------------------------------------------------------------------

jest.mock('../tools', () => ({ createAllTools: jest.fn(() => []) }));

import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { AiBudgetChatFactory } from '../../ai-budget/ai-budget-chat.factory';
import { Client as LangSmithClient } from 'langsmith';
import { CompiledStateGraph } from '@langchain/langgraph';
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { PrivateTraceClient, RedactingClient } from '../trace-redaction';

// Hermetic guard: test-setup blocks and records any LangSmith HTTP call (either langsmith copy).
const langsmithOutbound = (): string[] => (globalThis as unknown as { __langsmithOutbound: string[] }).__langsmithOutbound;
afterEach(() => expect(langsmithOutbound()).toEqual([]));

describe('LangGraphAgentRunner.run with the AI Budget tool group', () => {
  const mk = tool as unknown as (fn: (args: { amount: string }) => Promise<string>, cfg: { name: string; description: string; schema: z.ZodTypeAny }) => StructuredToolInterface;
  const aiBudgetTool = mk(async ({ amount }) => `Biedronka ${amount}`, {
    name: 'ai_budget_get_expenses',
    description: 'test',
    schema: z.object({ amount: z.string().regex(/^\d+(\.\d{1,2})?$/) }),
  });

  function setup(opts: { binding?: boolean; nonCompany?: boolean; responses?: AIMessage[] } = {}) {
    const bound: { tools: string[]; calls: BaseMessage[][] } = { tools: [], calls: [] };
    const responses = opts.responses ?? [new AIMessage('done')];
    const fakeModel = {
      bindTools: (tools: { name: string }[]) => {
        bound.tools = tools.map(t => t.name);
        return {
          invoke: async (messages: BaseMessage[]) => {
            bound.calls.push(messages);
            return responses.shift() ?? new AIMessage('done');
          },
        };
      },
    };
    jest.spyOn(LangGraphAgentRunner, 'createModel').mockReturnValue(fakeModel as never);
    const credentials = { getLLMCredentials: jest.fn().mockResolvedValue({ provider: 'openai', apiKey: 'sk', model: 'gpt-4o' }) };
    const wfirma = { getServiceForUser: jest.fn().mockResolvedValue({}) };
    const factory = {
      forRun: jest.fn().mockResolvedValue(
        opts.binding === false
          ? null
          : { tools: [aiBudgetTool], promptFragment: '## AI Budget rules\n- test rule', nonCompanyDataUsed: () => !!opts.nonCompany },
      ),
    };
    const runner = new LangGraphAgentRunner(
      credentials as never, wfirma as never, {} as never, {} as never, undefined,
      factory as unknown as AiBudgetChatFactory,
    );
    return { runner, factory, bound, credentials };
  }

  const systemPromptOf = (bound: { calls: BaseMessage[][] }) => String(bound.calls[0][0].content);

  afterEach(() => jest.restoreAllMocks());

  test('binds AI Budget tools and appends the rules fragment when the factory returns a binding', async () => {
    const { runner, bound } = setup();
    await runner.run([], 'Pokaż wydatki', 'u1', 'c1', 'openai');
    expect(bound.tools).toContain('ai_budget_get_expenses');
    expect(systemPromptOf(bound)).toContain('## AI Budget rules');
  });

  test('passes isShared through as company_only scope', async () => {
    const { runner, factory } = setup();
    await runner.run([], 'Pokaż wydatki', 'u1', 'c1', 'openai', { isShared: true });
    expect(factory.forRun).toHaveBeenCalledWith('u1', 'pl', { isShared: true });
  });

  test('a non-shared run asks for every account', async () => {
    const { runner, factory } = setup();
    await runner.run([], 'Pokaż wydatki', 'u1', 'c1', 'openai');
    expect(factory.forRun).toHaveBeenCalledWith('u1', 'pl', { isShared: false });
  });

  test('no binding → no AI Budget tools and no fragment', async () => {
    const { runner, bound } = setup({ binding: false });
    const result = await runner.run([], 'show expenses', 'u1', 'c1', 'openai');
    expect(bound.tools.some(n => n.startsWith('ai_budget_'))).toBe(false);
    expect(systemPromptOf(bound)).not.toContain('## AI Budget rules');
    expect(result.aiBudgetNonCompanyDataUsed).toBe(false);
  });

  test('a failing factory does not break the run', async () => {
    const { runner, factory, bound } = setup();
    factory.forRun.mockRejectedValue(new Error('redis down'));
    const result = await runner.run([], 'show expenses', 'u1', 'c1', 'openai');
    expect(result.response).toBe('done');
    expect(bound.tools.some(n => n.startsWith('ai_budget_'))).toBe(false);
  });

  test('returns aiBudgetNonCompanyDataUsed from the binding', async () => {
    const { runner } = setup({ nonCompany: true });
    const result = await runner.run([], 'show expenses', 'u1', 'c1', 'openai');
    expect(result.aiBudgetNonCompanyDataUsed).toBe(true);
  });

  test('an AI Budget tool rejecting bad arguments becomes a tool error message, not a crashed run', async () => {
    const { runner, bound } = setup({
      responses: [
        new AIMessage({ content: '', tool_calls: [{ id: 'call1', name: 'ai_budget_get_expenses', args: { amount: 'abc' } }] }),
        new AIMessage('sorry'),
      ],
    });
    const result = await runner.run([], 'show expenses', 'u1', 'c1', 'openai');
    expect(result.response).toBe('sorry');
    expect(result.toolsUsed).toEqual(['ai_budget_get_expenses']);
    const toolMsg = bound.calls[1].find(m => m instanceof ToolMessage) as ToolMessage;
    expect(toolMsg).toBeDefined();
    expect(String(toolMsg.content)).toMatch(/^Error/);
    expect(String(toolMsg.content)).not.toContain('Biedronka');
  });

  test('a user without an LLM key triggers no AI Budget call', async () => {
    const { runner, factory, credentials } = setup();
    credentials.getLLMCredentials.mockResolvedValue(null);
    expect(await runner.bindAiBudget('u1', 'show expenses', false)).toBeNull();
    expect(factory.forRun).not.toHaveBeenCalled();
    await expect(runner.run([], 'show expenses', 'u1', 'c1', 'openai')).rejects.toThrow('No LLM API key configured');
    expect(factory.forRun).not.toHaveBeenCalled();
  });

  test('a binding made beforehand is used as is: the factory is not asked again', async () => {
    const { runner, factory, bound } = setup();
    const pre = await runner.bindAiBudget('u1', 'Pokaż wydatki', false);
    factory.forRun.mockClear();
    await runner.run([], 'Pokaż wydatki', 'u1', 'c1', 'openai', { aiBudget: pre });
    expect(factory.forRun).not.toHaveBeenCalled();
    expect(bound.tools).toContain('ai_budget_get_expenses');
  });

  test('a pre-bound null means no AI Budget group, even with a factory', async () => {
    const { runner, factory, bound } = setup();
    await runner.run([], 'show expenses', 'u1', 'c1', 'openai', { aiBudget: null });
    expect(factory.forRun).not.toHaveBeenCalled();
    expect(bound.tools.some(n => n.startsWith('ai_budget_'))).toBe(false);
  });

  test('graph.invoke receives a tracer bound to the caller\'s trace client', async () => {
    const invokeSpy = jest.spyOn(CompiledStateGraph.prototype, 'invoke');
    // No live HTTP: the tracer posts through the client, whose transport is stubbed.
    jest.spyOn(LangSmithClient.prototype, 'createRun').mockResolvedValue(undefined);
    jest.spyOn(LangSmithClient.prototype, 'updateRun').mockResolvedValue(undefined);
    const traceClient = new RedactingClient({ apiKey: 'test', autoBatchTracing: false });
    const { runner } = setup();
    await runner.run([], 'show expenses', 'u1', 'c1', 'openai', { traceClient });
    await awaitAllCallbacks();
    const config = invokeSpy.mock.calls[0][1] as { callbacks?: { name: string; client: unknown }[] };
    expect(config.callbacks).toHaveLength(1);
    expect(config.callbacks?.[0].name).toBe('langchain_tracer');
    expect(config.callbacks?.[0].client).toBe(traceClient);
  });

  test('with a private trace client, no graph, chain or tool run posts message content', async () => {
    const prev = process.env.LANGCHAIN_TRACING_V2;
    process.env.LANGCHAIN_TRACING_V2 = 'true';
    const createSpy = jest.spyOn(LangSmithClient.prototype, 'createRun').mockResolvedValue(undefined);
    const updateSpy = jest.spyOn(LangSmithClient.prototype, 'updateRun').mockResolvedValue(undefined);
    try {
      const traceClient = new PrivateTraceClient({ apiKey: 'test', autoBatchTracing: false });
      const { runner } = setup({
        responses: [
          new AIMessage({ content: '', tool_calls: [{ id: 'call1', name: 'ai_budget_get_expenses', args: { amount: '42.50' } }] }),
          new AIMessage('You spent 42.50 at Biedronka'),
        ],
      });
      await runner.run([], 'show my private expenses', 'u1', 'c1', 'openai', { traceClient });
      await awaitAllCallbacks();
      await new Promise(r => setTimeout(r, 50));
      expect(createSpy.mock.calls.map(([r]) => (r as { name: string }).name)).toEqual(expect.arrayContaining(['ai_budget_get_expenses']));
      const sent = JSON.stringify([...createSpy.mock.calls, ...updateSpy.mock.calls]);
      expect(sent).not.toContain('Biedronka');
      expect(sent).not.toContain('show my private expenses');
      expect(sent).not.toContain('## AI Budget rules');
      expect(createSpy.mock.contexts.every(c => c instanceof PrivateTraceClient)).toBe(true);
    } finally {
      createSpy.mockRestore();
      updateSpy.mockRestore();
      process.env.LANGCHAIN_TRACING_V2 = prev;
    }
  });
});
