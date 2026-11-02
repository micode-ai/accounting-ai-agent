/**
 * LangSmith trace redaction for AI Budget data.
 * Private and other-business AI Budget data must never reach a trace. Every payload the tracing client
 * sends goes through `redactAiBudgetPayload`: a tool message of an `ai_budget_*` tool loses its content,
 * and an `ai_budget_*` tool call loses its arguments. A run of an `ai_budget_*` tool loses its inputs
 * and outputs as a whole (`redactAiBudgetRun`), since its inputs are the raw tool arguments.
 *
 * A private trace (Ruling 12: the conversation is flagged, or the run binds the AI Budget tools with the
 * `all` scope) goes through `PrivateTraceClient` instead, which blanks every run's inputs, outputs,
 * error and events: the model's own answer may restate private figures. The choice is made per message,
 * before the root run is posted, and every child run inherits the root's client.
 */

import { Client } from 'langsmith';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { AI_BUDGET_TOOL_PREFIX } from './tools/ai-budget.tools';

export const REDACTED = '[redacted: AI Budget data]';

const isAiBudgetName = (v: unknown): boolean => typeof v === 'string' && v.startsWith(AI_BUDGET_TOOL_PREFIX);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function redactNode(node: Json): Json {
  if (Array.isArray(node)) return node.map(redactNode);
  if (node === null || typeof node !== 'object') return node;

  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(node)) out[k] = redactNode(v);

  if (isAiBudgetName(out.name)) {
    for (const field of ['content', 'args', 'arguments', 'artifact']) {
      if (field in out) out[field] = REDACTED;
    }
  }
  const kwargs = out.kwargs;
  if (kwargs && typeof kwargs === 'object' && !Array.isArray(kwargs) && isAiBudgetName(kwargs.name)) {
    for (const field of ['content', 'artifact']) {
      if (field in kwargs) kwargs[field] = REDACTED;
    }
  }
  return out;
}

/**
 * Returns a redacted deep copy. Live LangChain objects are first normalized through their JSON form, so
 * a message instance and its serialized form are redacted alike. A payload that cannot be serialized is
 * replaced as a whole (fail closed).
 */
export function redactAiBudgetPayload<T>(value: T): T {
  let plain: Json;
  try {
    const json = JSON.stringify(value);
    // Nothing named ai_budget_* anywhere: nothing to redact, skip the copy.
    if (json === undefined || !json.includes(AI_BUDGET_TOOL_PREFIX)) return value;
    plain = JSON.parse(json) as Json;
  } catch {
    return { redacted: REDACTED } as unknown as T;
  }
  return redactNode(plain) as unknown as T;
}

/** A run of an `ai_budget_*` tool keeps its name and loses its inputs and outputs. */
export function redactAiBudgetRun<R extends { name?: string; inputs?: unknown; outputs?: unknown }>(run: R): R {
  return isAiBudgetName(run.name) ? redactRunIo(run) : run;
}

function redactRunIo<R extends { inputs?: unknown; outputs?: unknown }>(run: R): R {
  return {
    ...run,
    ...(run.inputs !== undefined ? { inputs: { redacted: REDACTED } } : {}),
    ...(run.outputs !== undefined ? { outputs: { redacted: REDACTED } } : {}),
  };
}

const MAX_TRACKED_RUNS = 5000;

/**
 * Posts every `ai_budget_*` run redacted. A run update carries no name, so the ids of those runs are kept
 * from their create until their update.
 */
export class RedactingClient extends Client {
  private readonly aiBudgetRunIds = new Set<string>();

  override async createRun(run: Parameters<Client['createRun']>[0]): Promise<void> {
    if (isAiBudgetName(run.name) && typeof run.id === 'string') {
      if (this.aiBudgetRunIds.size >= MAX_TRACKED_RUNS) {
        const oldest = this.aiBudgetRunIds.values().next().value;
        if (oldest !== undefined) this.aiBudgetRunIds.delete(oldest);
      }
      this.aiBudgetRunIds.add(run.id);
    }
    return super.createRun(redactAiBudgetRun(run));
  }

  override async updateRun(runId: string, run: Parameters<Client['updateRun']>[1]): Promise<void> {
    if (!this.aiBudgetRunIds.has(runId)) return super.updateRun(runId, run);
    // Deleted only once the update carries an end time: a run may be patched more than once.
    if (run.end_time !== undefined) this.aiBudgetRunIds.delete(runId);
    return super.updateRun(runId, redactRunIo(run));
  }
}

const BLANK = { redacted: REDACTED };

function blankRun<R extends object>(run: R): R {
  const out = { ...run } as Record<string, unknown>;
  for (const field of ['inputs', 'outputs']) if (out[field] !== undefined) out[field] = BLANK;
  if (out.error !== undefined && out.error !== null) out.error = REDACTED;
  if (out.events !== undefined) out.events = [];
  if (out.attachments !== undefined) delete out.attachments;
  return out as unknown as R;
}

/** Blanks the inputs, outputs, error and events of every run it posts, creates and updates alike. */
export class PrivateTraceClient extends Client {
  override async createRun(run: Parameters<Client['createRun']>[0]): Promise<void> {
    return super.createRun(blankRun(run));
  }

  override async updateRun(runId: string, run: Parameters<Client['updateRun']>[1]): Promise<void> {
    return super.updateRun(runId, blankRun(run));
  }
}

let traceClient: Client | undefined;
let privateTraceClient: Client | undefined;

/**
 * The client a root `traceable` must pass as `client` (child runs, LangChain runs included, inherit it):
 * the private one for a private trace, otherwise the name-based redacting one. undefined when tracing is
 * off.
 */
export function getTraceClient(opts: { private?: boolean } = {}): Client | undefined {
  return opts.private ? privateTraceClient : traceClient;
}

/**
 * Callbacks for a LangChain/LangGraph invoke: a tracer bound to the given (or the name-based) client, so
 * the default, unredacted tracer is never added. `@langchain/core` keeps its default client private,
 * hence this instead of replacing that singleton. undefined when tracing is off.
 */
export function redactingTracerCallbacks(client: Client | undefined = traceClient): LangChainTracer[] | undefined {
  if (!client) return undefined;
  // @langchain/core bundles its own langsmith version; the client is structurally compatible.
  return [new LangChainTracer({ client: client as never })];
}

/** Every variable langsmith / @langchain/core read to turn tracing on (any of them set to "true"). */
export const TRACING_ENV_VARS = ['LANGSMITH_TRACING_V2', 'LANGCHAIN_TRACING_V2', 'LANGSMITH_TRACING', 'LANGCHAIN_TRACING'] as const;

export function isTracingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return TRACING_ENV_VARS.some((name) => env[name] === 'true');
}

/** Call once at boot. A no-op unless LangSmith tracing is on. */
export function installTraceRedaction(): void {
  if (!isTracingEnabled() || traceClient) return;
  traceClient = new RedactingClient({ hideInputs: redactAiBudgetPayload, hideOutputs: redactAiBudgetPayload });
  privateTraceClient = new PrivateTraceClient({ hideInputs: () => BLANK, hideOutputs: () => BLANK });
}

/** Tests only. */
export function resetTraceRedactionForTests(): void {
  traceClient = undefined;
  privateTraceClient = undefined;
}
