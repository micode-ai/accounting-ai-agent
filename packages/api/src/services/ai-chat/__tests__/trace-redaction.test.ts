import { AIMessage, ToolMessage, HumanMessage } from '@langchain/core/messages';
import { Client } from 'langsmith';
import * as mod from '../trace-redaction';
import { REDACTED, redactAiBudgetPayload, redactAiBudgetRun, RedactingClient, PrivateTraceClient } from '../trace-redaction';

// Hermetic guard: test-setup blocks and records any LangSmith HTTP call (either langsmith copy).
const langsmithOutbound = (): string[] => (globalThis as unknown as { __langsmithOutbound: string[] }).__langsmithOutbound;
afterEach(() => expect(langsmithOutbound()).toEqual([]));

describe('redactAiBudgetPayload', () => {
  test('redacts ToolMessages of ai_budget_* tools, serialized or plain', () => {
    const input = {
      messages: [[
        { lc: 1, type: 'constructor', id: ['langchain_core', 'messages', 'ToolMessage'], kwargs: { content: 'Biedronka 42.50', name: 'ai_budget_get_expenses', tool_call_id: 't' } },
        { role: 'tool', name: 'get_invoices', content: 'FV/1' },
        { role: 'tool', name: 'ai_budget_spending_summary', content: 'Lidl 10.00' },
      ]],
    };
    const out = JSON.stringify(redactAiBudgetPayload(input));
    expect(out).not.toContain('Biedronka');
    expect(out).not.toContain('Lidl');
    expect(out).toContain('FV/1');
    expect(out).toContain(REDACTED);
  });

  test('redacts live LangChain message instances', () => {
    const input = {
      messages: [
        new HumanMessage('show my expenses'),
        new ToolMessage({ content: 'Biedronka 42.50', name: 'ai_budget_get_expenses', tool_call_id: 't1' }),
        new ToolMessage({ content: 'FV/1', name: 'get_invoices', tool_call_id: 't2' }),
      ],
    };
    const out = JSON.stringify(redactAiBudgetPayload(input));
    expect(out).not.toContain('Biedronka');
    expect(out).toContain('FV/1');
    expect(out).toContain('show my expenses');
  });

  test('redacts the arguments of ai_budget_* tool calls', () => {
    const msg = new AIMessage({
      content: '',
      tool_calls: [{ id: 'c1', name: 'ai_budget_create_expense', args: { description: 'Pharmacy', amount: '19.99' } }],
      additional_kwargs: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ai_budget_create_expense', arguments: '{"description":"Pharmacy"}' } }] },
    });
    const out = JSON.stringify(redactAiBudgetPayload({ generations: [[{ message: msg }]] }));
    expect(out).not.toContain('Pharmacy');
    expect(out).toContain('ai_budget_create_expense');
  });

  test('does not mutate its input', () => {
    const input = { messages: [{ role: 'tool', name: 'ai_budget_get_expenses', content: 'Biedronka 42.50' }] };
    const snapshot = JSON.stringify(input);
    const out = redactAiBudgetPayload(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).not.toBe(input);
  });

  test('fails closed on an unserializable payload', () => {
    const circular: Record<string, unknown> = { content: 'Biedronka' };
    circular.self = circular;
    expect(JSON.stringify(redactAiBudgetPayload(circular))).not.toContain('Biedronka');
  });
});

describe('redactAiBudgetRun', () => {
  test('replaces the inputs and outputs of an ai_budget_* tool run', () => {
    const run = { name: 'ai_budget_create_expense', run_type: 'tool', inputs: { input: '{"description":"Pharmacy"}' }, outputs: { output: 'ok' } };
    const out = redactAiBudgetRun(run);
    expect(JSON.stringify(out)).not.toContain('Pharmacy');
    expect(out.name).toBe('ai_budget_create_expense');
    expect(run.inputs.input).toContain('Pharmacy');
  });

  test('leaves other runs untouched', () => {
    const run = { name: 'get_invoices', inputs: { input: 'FV/1' } };
    expect(redactAiBudgetRun(run)).toBe(run);
  });
});

describe('RedactingClient', () => {
  test('redacts the create and the later update of an ai_budget_* run, and nothing else', async () => {
    const createSpy = jest.spyOn(Client.prototype, 'createRun').mockResolvedValue(undefined);
    const updateSpy = jest.spyOn(Client.prototype, 'updateRun').mockResolvedValue(undefined);
    const client = new RedactingClient({ apiKey: 'test', autoBatchTracing: false });

    await client.createRun({ id: 'r1', name: 'ai_budget_get_expenses', run_type: 'tool', inputs: { input: 'Pharmacy' } });
    await client.updateRun('r1', { end_time: Date.now(), inputs: { input: 'Pharmacy' }, outputs: { output: 'Biedronka' } });
    await client.createRun({ id: 'r2', name: 'get_invoices', run_type: 'tool', inputs: { input: 'FV/1' } });
    await client.updateRun('r2', { end_time: Date.now(), outputs: { output: 'FV/1' } });

    const sent = JSON.stringify([...createSpy.mock.calls, ...updateSpy.mock.calls]);
    expect(sent).not.toContain('Pharmacy');
    expect(sent).not.toContain('Biedronka');
    expect(sent).toContain('FV/1');
    expect(updateSpy.mock.calls[0][1]).not.toHaveProperty('name');
    createSpy.mockRestore();
    updateSpy.mockRestore();
  });
});

describe('installTraceRedaction', () => {
  const prev = process.env.LANGCHAIN_TRACING_V2;
  afterEach(async () => {
    process.env.LANGCHAIN_TRACING_V2 = prev;
    mod.resetTraceRedactionForTests();
  });

  test('is a no-op when tracing is off', async () => {
    process.env.LANGCHAIN_TRACING_V2 = 'false';
    mod.installTraceRedaction();
    expect(mod.getTraceClient()).toBeUndefined();
    expect(mod.redactingTracerCallbacks()).toBeUndefined();
  });

  test('installs a redacting client and a tracer bound to it when tracing is on', async () => {
    process.env.LANGCHAIN_TRACING_V2 = 'true';
    mod.installTraceRedaction();
    const client = mod.getTraceClient();
    expect(client).toBeInstanceOf(mod.RedactingClient);
    const [tracer] = mod.redactingTracerCallbacks() ?? [];
    expect((tracer as unknown as { client: unknown }).client).toBe(client);
  });
});

describe('PrivateTraceClient and the short-circuit', () => {
  test('blanks inputs, outputs, error and events of every run, create and update alike', async () => {
    const createSpy = jest.spyOn(Client.prototype, 'createRun').mockResolvedValue(undefined);
    const updateSpy = jest.spyOn(Client.prototype, 'updateRun').mockResolvedValue(undefined);
    const client = new PrivateTraceClient({ apiKey: 'test', autoBatchTracing: false });
    await client.createRun({ id: 'r1', name: 'ChatOpenAI', run_type: 'llm', inputs: { messages: ['Biedronka 42.50'] } });
    await client.updateRun('r1', {
      end_time: Date.now(), outputs: { text: 'You spent 42.50 at Biedronka' }, error: 'Biedronka',
      events: [{ name: 'new_token', kwargs: { token: 'Biedronka' } }],
    });
    const sent = JSON.stringify([...createSpy.mock.calls, ...updateSpy.mock.calls]);
    expect(sent).not.toContain('Biedronka');
    expect(sent).toContain('ChatOpenAI');
    createSpy.mockRestore();
    updateSpy.mockRestore();
  });

  test('a payload with no ai_budget_ name is returned as is, without a copy', () => {
    const input = { messages: [{ role: 'tool', name: 'get_invoices', content: 'FV/1' }] };
    expect(redactAiBudgetPayload(input)).toBe(input);
  });

  test('getTraceClient picks the private client for a private trace', async () => {
    const prev = process.env.LANGCHAIN_TRACING_V2;
    process.env.LANGCHAIN_TRACING_V2 = 'true';
    mod.installTraceRedaction();
    expect(mod.getTraceClient({ private: true })).toBeInstanceOf(mod.PrivateTraceClient);
    expect(mod.getTraceClient()).toBeInstanceOf(mod.RedactingClient);
    const [tracer] = mod.redactingTracerCallbacks(mod.getTraceClient({ private: true })) ?? [];
    expect((tracer as unknown as { client: unknown }).client).toBe(mod.getTraceClient({ private: true }));
    mod.resetTraceRedactionForTests();
    process.env.LANGCHAIN_TRACING_V2 = prev;
  });
});

describe('isTracingEnabled', () => {
  test.each(['LANGSMITH_TRACING_V2', 'LANGCHAIN_TRACING_V2', 'LANGSMITH_TRACING', 'LANGCHAIN_TRACING'])('%s=true turns tracing on', (name) => {
    expect(mod.isTracingEnabled({ [name]: 'true' })).toBe(true);
  });

  test('off when none is "true"', () => {
    expect(mod.isTracingEnabled({ LANGCHAIN_TRACING_V2: 'false', LANGSMITH_TRACING: '1' })).toBe(false);
  });

  test('installTraceRedaction honours LANGSMITH_TRACING alone', () => {
    process.env.LANGSMITH_TRACING = 'true';
    try {
      mod.installTraceRedaction();
      expect(mod.getTraceClient()).toBeInstanceOf(RedactingClient);
      expect(mod.getTraceClient({ private: true })).toBeInstanceOf(PrivateTraceClient);
    } finally {
      delete process.env.LANGSMITH_TRACING;
      mod.resetTraceRedactionForTests();
    }
  });

  test('test setup keeps tracing off whatever the developer .env says', () => {
    expect(mod.isTracingEnabled()).toBe(false);
    expect(process.env.LANGCHAIN_API_KEY).toBeUndefined();
    expect(process.env.LANGSMITH_API_KEY).toBeUndefined();
  });
});
