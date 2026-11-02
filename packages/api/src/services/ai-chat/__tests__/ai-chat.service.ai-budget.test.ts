import { traceable } from 'langsmith/traceable';
import { Client } from 'langsmith';
import { AIChatService } from '../ai-chat.service';
import { TTSIntegration } from '../tts-integration';
import {
  installTraceRedaction, resetTraceRedactionForTests, getTraceClient, PrivateTraceClient, RedactingClient,
} from '../trace-redaction';
import type { ConversationRepository } from '../conversation-repository';
import type { LangGraphAgentRunner } from '../langgraph-agent-runner';

jest.mock('../../../utils/logger', () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

// Hermetic guard: test-setup blocks and records any LangSmith HTTP call (either langsmith copy).
const langsmithOutbound = (): string[] => (globalThis as unknown as { __langsmithOutbound: string[] }).__langsmithOutbound;
afterEach(() => expect(langsmithOutbound()).toEqual([]));

const BINDING = { tools: [], promptFragment: '## AI Budget rules', nonCompanyDataUsed: () => false };
const ANSWER = 'You spent 42.50 at Biedronka';

function setup(opts: { isShared: boolean; nonCompany?: boolean; flagged?: boolean; binding?: boolean; tts?: TTSIntegration }) {
  const order: string[] = [];
  const repo = {
    findAuthorized: jest.fn().mockResolvedValue({
      id: 'c1', userId: 'u1', title: 't', messages: [], isShared: opts.isShared, containsPrivateAiBudgetData: !!opts.flagged,
    }),
    getUserDisplayName: jest.fn().mockResolvedValue('Ann'),
    updateMessages: jest.fn(async () => { order.push('updateMessages'); }),
    markContainsPrivateAiBudgetData: jest.fn(async () => { order.push('mark'); }),
  };
  const runner = {
    bindAiBudget: jest.fn().mockResolvedValue(opts.binding === false ? null : BINDING),
    // Stands in for the LangGraph run: a child run that carries the message and the answer.
    run: jest.fn(async (_m: unknown, content: string) => {
      await traceable(async (_text: string) => ANSWER, { name: 'ChatOpenAI', run_type: 'llm' })(content);
      return {
        response: ANSWER, toolsUsed: [], actualProvider: 'openai', actualModel: 'gpt-4o', locale: 'en',
        aiBudgetNonCompanyDataUsed: !!opts.nonCompany,
      };
    }),
  };
  const svc = new AIChatService(
    repo as unknown as ConversationRepository,
    runner as unknown as LangGraphAgentRunner,
    opts.tts ?? ({ generateForResponse: jest.fn() } as unknown as TTSIntegration),
  );
  return { repo, runner, svc, order };
}

describe('AIChatService.sendMessage and AI Budget', () => {
  test('sendMessage passes conversation.isShared and marks the conversation when non-company data was used', async () => {
    const { repo, runner, svc, order } = setup({ isShared: false, nonCompany: true });
    await svc.sendMessage('c1', 'u1', 'show my private expenses', 'openai', { ttsEnabled: false });
    expect(runner.bindAiBudget).toHaveBeenCalledWith('u1', 'show my private expenses', false);
    expect(runner.run).toHaveBeenCalledWith(
      [], 'show my private expenses', 'u1', 'c1', 'openai', expect.objectContaining({ isShared: false, aiBudget: BINDING }),
    );
    expect(repo.markContainsPrivateAiBudgetData).toHaveBeenCalledTimes(1);
    expect(repo.markContainsPrivateAiBudgetData).toHaveBeenCalledWith('c1');
    expect(order).toEqual(['mark', 'updateMessages']);
  });

  test('a shared conversation runs with isShared and is not marked when only company data was used', async () => {
    const { repo, runner, svc } = setup({ isShared: true });
    await svc.sendMessage('c1', 'u1', 'company expenses', 'openai', { ttsEnabled: false });
    expect(runner.run).toHaveBeenCalledWith([], 'company expenses', 'u1', 'c1', 'openai', expect.objectContaining({ isShared: true }));
    expect(repo.markContainsPrivateAiBudgetData).not.toHaveBeenCalled();
  });
});

describe('AIChatService.sendMessage trace privacy (Ruling 12)', () => {
  const prev = process.env.LANGCHAIN_TRACING_V2;
  let createSpy: jest.SpyInstance;
  let updateSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.LANGCHAIN_TRACING_V2 = 'true';
    installTraceRedaction();
    createSpy = jest.spyOn(Client.prototype, 'createRun').mockResolvedValue(undefined);
    updateSpy = jest.spyOn(Client.prototype, 'updateRun').mockResolvedValue(undefined);
  });
  afterEach(() => {
    createSpy.mockRestore();
    updateSpy.mockRestore();
    resetTraceRedactionForTests();
    process.env.LANGCHAIN_TRACING_V2 = prev;
  });

  const flush = () => new Promise(r => setTimeout(r, 100));
  const sent = () => JSON.stringify([...createSpy.mock.calls, ...updateSpy.mock.calls]);
  const rootClient = () => createSpy.mock.contexts[createSpy.mock.calls.findIndex(([r]) => r.name === 'ai_chat_message')];

  function realTts(): TTSIntegration {
    const ttsService = { synthesize: jest.fn().mockResolvedValue(Buffer.from('audio')) };
    return new TTSIntegration(ttsService as never, {} as never);
  }

  test('a run with the all-account scope posts no message content, answer text or tts input', async () => {
    const { runner, svc } = setup({ isShared: false, tts: realTts() });
    await svc.sendMessage('c1', 'u1', 'show my private expenses', 'openai');
    await flush();
    const names = createSpy.mock.calls.map(([r]) => r.name);
    expect(names).toEqual(expect.arrayContaining(['ai_chat_message', 'ChatOpenAI', 'tts_synthesis']));
    expect(updateSpy).toHaveBeenCalled();
    expect(sent()).not.toContain('show my private expenses');
    expect(sent()).not.toContain('Biedronka');
    expect(rootClient()).toBeInstanceOf(PrivateTraceClient);
    expect(createSpy.mock.contexts.every(c => c instanceof PrivateTraceClient)).toBe(true);
    expect((runner.run.mock.calls[0] as unknown[])[5]).toEqual(expect.objectContaining({ traceClient: getTraceClient({ private: true }) }));
  });

  test('an already-flagged conversation with no binding this turn is still private', async () => {
    const { svc } = setup({ isShared: true, flagged: true, binding: false, tts: realTts() });
    await svc.sendMessage('c1', 'u1', 'show my private expenses', 'openai');
    await flush();
    expect(rootClient()).toBeInstanceOf(PrivateTraceClient);
    expect(sent()).not.toContain('Biedronka');
    expect(sent()).not.toContain('show my private expenses');
  });

  test('a shared-scope (company_only) run keeps the name-based redaction', async () => {
    const { runner, svc } = setup({ isShared: true });
    await svc.sendMessage('c1', 'u1', 'company expenses', 'openai', { ttsEnabled: false });
    await flush();
    const root = rootClient();
    expect(root).toBeInstanceOf(RedactingClient);
    expect(root).not.toBeInstanceOf(PrivateTraceClient);
    expect(sent()).toContain('company expenses');
    expect((runner.run.mock.calls[0] as unknown[])[5]).toEqual(expect.objectContaining({ traceClient: getTraceClient() }));
  });

  test('a Telegram group (aiBudgetCompanyOnly) binds the company-only scope and is not a private trace by scope', async () => {
    const { runner, svc } = setup({ isShared: false });
    await svc.sendMessage('c1', 'u1', 'company expenses', 'openai', { ttsEnabled: false, aiBudgetCompanyOnly: true });
    await flush();
    expect(runner.bindAiBudget).toHaveBeenCalledWith('u1', 'company expenses', true);
    expect(rootClient()).toBeInstanceOf(RedactingClient);
    expect(rootClient()).not.toBeInstanceOf(PrivateTraceClient);
  });

  test('a Telegram group on an already-flagged conversation is still a private trace', async () => {
    const { svc } = setup({ isShared: false, flagged: true });
    await svc.sendMessage('c1', 'u1', 'company expenses', 'openai', { ttsEnabled: false, aiBudgetCompanyOnly: true });
    await flush();
    expect(rootClient()).toBeInstanceOf(PrivateTraceClient);
  });

  test('a non-shared chat without an AI Budget connection keeps the name-based redaction', async () => {
    const { svc } = setup({ isShared: false, binding: false });
    await svc.sendMessage('c1', 'u1', 'invoices please', 'openai', { ttsEnabled: false });
    await flush();
    expect(rootClient()).toBeInstanceOf(RedactingClient);
    expect(rootClient()).not.toBeInstanceOf(PrivateTraceClient);
  });
});
