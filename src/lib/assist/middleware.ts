/**
 * Ported from wacrm module 019e (assistant middleware), reference package 2026-10-20 (src/assist/middleware.ts). Pure TS;
 * only imports were adapted (wacrm module paths). "workspace" (workspaceId) is the wacrm account id.
 *
 * Agent middleware pipeline (module 019e). A small self-contained hook pipeline around the 019a tool layer; NOT a
 * LangChain dependency. One run:
 *   beforeAgent   (in list order)
 *   repeat, at most maxRounds model rounds (default 8, 1..64, never unbounded):
 *     beforeModel   (in list order)
 *     wrapModelCall (onion: the first middleware is the outermost; the terminal calls deps.model once)
 *     afterModel    (reverse list order)
 *     no tool-call proposals left -> the run completes
 *     tool step: every proposal goes through deps.router.execute (the 019a ModelToolRouter). The router is the
 *                terminal of the tool step; no hook takes part in it and no hook can replace it.
 *   afterAgent    (reverse list order); then the frozen result is returned.
 * Security rules:
 *   - Fail closed: a hook that throws aborts the run with AgentMiddlewareError(hook, middleware). Nothing further is
 *     written: no more hooks, no model call, no tool call, no result.
 *   - Identity (runId, userId, workspaceId, channel, mode) is frozen on the state; an assignment throws, and every hook
 *     is followed by a check that it is unchanged. The router context is built once from the input, never from state.
 *     Identity, router context and state are null-prototype objects, so Object.prototype pollution cannot supply a mode.
 *   - Tool-call proposals originate only from the model: wrapModelCall and afterModel may only remove or keep the
 *     proposals they were given, never add, modify, duplicate or reorder one. A hook's output is snapshotted once
 *     (each field read once, index loop over a length read once) into fresh frozen objects; only the snapshot is
 *     checked and used. Each wrap layer is checked against what its inner layer returned, so an outer layer cannot
 *     restore a call an inner layer removed. next() is valid only while its wrap hook is running.
 *   - Model-issued args must be JSON data (plain objects, arrays, strings, finite numbers, booleans, null); they are
 *     deep-copied and deep-frozen at ingestion. Anything else (Map, Set, Date, functions, cycles, accessors) is an
 *     AgentModelError.
 *   - Redaction is terminal: every middleware's terminalRedact runs after all wrap layers, immediately before
 *     deps.model, on a fresh snapshot of the messages. A throwing or refusing redactor aborts the run. The snapshot
 *     keeps role / content / toolCallId / name. The 019f prompt-cache fields (promptTier, cacheControl
 *     {type:"ephemeral"}, cacheKey, tools) are kept ONLY on the leading run of messages that are the very objects a
 *     sanctioned cache-tier installer registered for this model call (same object AND same sha256 of canonical JSON,
 *     at most MAX_CACHE_BREAKPOINTS); every other message, anywhere, loses all of them. Redactors see the message
 *     without them; for a kept message they also run over cacheKey and the canonical JSON of tools, and a redactor
 *     that would change anything in a kept message aborts the run (fail closed).
 *   - Hooks never see the router, a handler, or the 019a ConfirmApi. A proposal's pendingId is passed to the router
 *     as the model gave it; the guard alone decides whether a human confirmed it. No hook output is a confirmation.
 *   - Deterministic: the clock is injected (deps.clock); no network.
 */
import { canonicalJson, sha256Hex } from './canonical';
import type { AssistContext } from './guard';
import { systemClock, type Clock } from './loop';
import type { AutonomyMode } from './registry';
import type { ModelToolRouter, RouterResult } from './router';

export const DEFAULT_MAX_ROUNDS = 8;
export const MAX_ROUNDS_LIMIT = 64;

export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';
const ROLES: ReadonlySet<string> = new Set<AgentRole>([
  'system',
  'user',
  'assistant',
  'tool',
]);

export interface AgentMessage {
  readonly role: AgentRole;
  readonly content: string;
  /** role 'tool': the proposal this result answers, and the tool name. */
  readonly toolCallId?: string;
  readonly name?: string;
}

export interface ProposedToolCall {
  readonly id: string;
  readonly tool: string;
  readonly args?: unknown;
  /** Passed to the router unchanged; only the 019a guard decides whether a human confirmed it. */
  readonly pendingId?: string;
}

export interface ModelResponse {
  readonly text: string;
  readonly toolCalls: readonly ProposedToolCall[];
}

export interface ModelRequest {
  readonly messages: readonly AgentMessage[];
}

export type ModelCall = (request: ModelRequest) => Promise<ModelResponse>;

export interface AgentState {
  readonly runId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly channel: string;
  readonly mode?: AutonomyMode;
  /** 1-based model round in progress (0 before the first round). */
  readonly round: number;
  /** Hooks may replace or rewrite messages; each must stay a valid AgentMessage. */
  messages: AgentMessage[];
}

export interface AgentRunCounts {
  readonly rounds: number;
  /** Proposals the model returned (before any middleware removed some). */
  readonly toolsProposed: number;
  /** Router outcome ok or error: the guard allowed the call and the handler ran. */
  readonly toolsAllowed: number;
  /** Router outcome denied. */
  readonly toolsRefused: number;
  /** Router outcome needs_confirmation: nothing ran, a human was asked. */
  readonly toolsPending: number;
}

export interface AgentResult {
  readonly status: 'completed' | 'round_cap';
  readonly text: string;
  readonly messages: readonly AgentMessage[];
  readonly counts: AgentRunCounts;
  readonly startedAt: number;
  readonly finishedAt: number;
}

export interface AgentInput {
  readonly runId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly channel: string;
  readonly mode?: AutonomyMode;
  readonly messages: readonly AgentMessage[];
}

export interface AgentDeps {
  readonly model: ModelCall;
  /** The only way a tool runs. There is deliberately no handler map here. */
  readonly router: ModelToolRouter;
  readonly clock?: Clock;
  readonly maxRounds?: number;
}

type Awaitable<T> = T | Promise<T>;

export interface AgentMiddleware {
  readonly name: string;
  beforeAgent?(state: AgentState): Awaitable<void>;
  beforeModel?(state: AgentState): Awaitable<void>;
  /** next() calls the inner layer at most once per round. */
  wrapModelCall?(
    state: AgentState,
    next: () => Promise<ModelResponse>,
    cacheTiers?: CacheTierChannel
  ): Promise<ModelResponse>;
  /** Return a response to replace the current one (text may change; tool calls may only be removed), or nothing. */
  afterModel?(
    state: AgentState,
    response: ModelResponse
  ): Awaitable<ModelResponse | void>;
  afterAgent?(state: AgentState, result: AgentResult): Awaitable<void>;
  /**
   * Applied by the pipeline to every message after all wrapModelCall layers, immediately before deps.model, whatever
   * this middleware's position in the list. Must return the redacted message or throw (the run aborts).
   */
  readonly terminalRedact?: (message: AgentMessage) => AgentMessage;
}

/** At most this many messages keep prompt-cache fields (breakpoints) in one model request (module 019f). */
export const MAX_CACHE_BREAKPOINTS = 2;

/**
 * Module 019f: the sanctioned channel by which a cache-tier installer (promptCacheMiddleware) registers, for one
 * model call, the exact cacheable-tier message objects it put at the head of state.messages. The pipeline passes it
 * as the third argument of wrapModelCall only to a sanctioned middleware, only while that hook runs, and accepts one
 * install per model call. Only the terminal step reads the registry; no hook can read or write it through
 * state, next() or a response.
 */
export interface CacheTierChannel {
  install(messages: readonly AgentMessage[]): void;
}

const SANCTIONED_CACHE_INSTALLERS = new WeakSet<object>();
/** Internal (019f): marks a middleware object built by promptCacheMiddleware as a cache-tier installer. */
export function sanctionCacheTierInstaller<T extends AgentMiddleware>(
  mw: T
): T {
  SANCTIONED_CACHE_INSTALLERS.add(mw);
  return mw;
}

export type HookName =
  | 'beforeAgent'
  | 'beforeModel'
  | 'wrapModelCall'
  | 'afterModel'
  | 'afterAgent'
  | 'terminalRedact';

export class AgentMiddlewareError extends Error {
  constructor(
    readonly hook: HookName,
    readonly middleware: string,
    options?: { cause?: unknown }
  ) {
    super(`agent middleware '${middleware}' failed in ${hook}`, options);
    this.name = 'AgentMiddlewareError';
  }
}

/** The model call failed or returned something that is not a ModelResponse. */
export class AgentModelError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentModelError';
  }
}

const IDENTITY_KEYS = [
  'runId',
  'userId',
  'workspaceId',
  'channel',
  'mode',
] as const;
type Identity = Pick<AgentInput, (typeof IDENTITY_KEYS)[number]>;

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v))
      deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

function isMessage(m: unknown): m is AgentMessage {
  if (m === null || typeof m !== 'object') return false;
  const x = m as Record<string, unknown>;
  return (
    typeof x.role === 'string' &&
    ROLES.has(x.role) &&
    typeof x.content === 'string' &&
    (x.toolCallId === undefined || typeof x.toolCallId === 'string') &&
    (x.name === undefined || typeof x.name === 'string')
  );
}

/** Deep copy of JSON data (read once per property); anything that is not JSON data throws. */
function cloneJson(v: unknown, seen: Set<object>): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('non-finite number');
    return v;
  }
  if (typeof v !== 'object')
    throw new TypeError(`${typeof v} is not JSON data`);
  if (seen.has(v)) throw new TypeError('cyclic value');
  seen.add(v);
  const proto = Object.getPrototypeOf(v);
  if (Object.getOwnPropertySymbols(v).length > 0)
    throw new TypeError('symbol keys are not JSON data');
  const read = (k: string): unknown => {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (d === undefined || !('value' in d))
      throw new TypeError('accessor or hole is not JSON data');
    return cloneJson(d.value, seen);
  };
  let out: unknown;
  if (Array.isArray(v)) {
    if (proto !== Array.prototype)
      throw new TypeError('array subclass is not JSON data');
    const len = v.length;
    const a: unknown[] = [];
    for (let i = 0; i < len; i++) a.push(read(String(i)));
    out = a;
  } else {
    if (proto !== Object.prototype && proto !== null)
      throw new TypeError('non-plain object is not JSON data');
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v))
      Object.defineProperty(o, k, {
        value: read(k),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    out = o;
  }
  seen.delete(v);
  return out;
}

/** A fresh frozen copy of one of our own (already frozen, data-only) call objects. */
function copyCall(c: ProposedToolCall): ProposedToolCall {
  const out: { id: string; tool: string; args?: unknown; pendingId?: string } =
    { id: c.id, tool: c.tool };
  if (c.args !== undefined) out.args = c.args;
  if (c.pendingId !== undefined) out.pendingId = c.pendingId;
  return Object.freeze(out);
}

/** Snapshot of a model response: every field read once, args deep-copied JSON data, everything frozen. */
function freezeModelResponse(raw: unknown): ModelResponse {
  if (raw === null || typeof raw !== 'object')
    throw new AgentModelError('model returned no response object');
  const r = raw as Record<string, unknown>;
  const text = r.text;
  const toolCalls = r.toolCalls;
  if (typeof text !== 'string' || !Array.isArray(toolCalls))
    throw new AgentModelError('model response is malformed');
  const len = toolCalls.length;
  const calls: ProposedToolCall[] = [];
  for (let i = 0; i < len; i++) {
    const x = (toolCalls[i] ?? {}) as Record<string, unknown>;
    const id = x.id,
      tool = x.tool,
      rawArgs = x.args,
      pendingId = x.pendingId;
    if (
      typeof id !== 'string' ||
      typeof tool !== 'string' ||
      (pendingId !== undefined && typeof pendingId !== 'string')
    ) {
      throw new AgentModelError('model tool call is malformed');
    }
    let args: unknown;
    try {
      args = rawArgs === undefined ? undefined : cloneJson(rawArgs, new Set());
    } catch (e) {
      throw new AgentModelError('model tool call args are not JSON data', {
        cause: e,
      });
    }
    const c: { id: string; tool: string; args?: unknown; pendingId?: string } =
      { id, tool };
    if (args !== undefined) c.args = deepFreeze(args);
    if (pendingId !== undefined) c.pendingId = pendingId;
    calls.push(Object.freeze(c));
  }
  return Object.freeze({ text, toolCalls: Object.freeze(calls) });
}

/**
 * A hook's response, snapshotted once: text may change; the tool calls must be an ordered subsequence (by identity,
 * each at most once, same relative order) of `allowed`. Only the returned snapshot (fresh frozen objects) is used.
 */
function snapshotResponse(
  out: unknown,
  allowed: readonly ProposedToolCall[],
  hook: HookName,
  name: string
): ModelResponse {
  const fail = (why: string) =>
    new AgentMiddlewareError(hook, name, { cause: new Error(why) });
  if (out === null || typeof out !== 'object')
    throw fail('hook returned no response object');
  let text: unknown;
  let toolCalls: unknown;
  const calls: ProposedToolCall[] = [];
  let cursor = 0;
  try {
    const r = out as Record<string, unknown>;
    text = r.text;
    toolCalls = r.toolCalls;
    if (typeof text !== 'string' || !Array.isArray(toolCalls))
      throw fail('hook returned a malformed response');
    const len = toolCalls.length;
    for (let i = 0; i < len; i++) {
      const c = toolCalls[i] as unknown;
      const j = allowed.indexOf(c as ProposedToolCall, cursor);
      if (j < 0)
        throw fail('hook added, modified, duplicated or reordered a tool call');
      calls.push(copyCall(allowed[j]!));
      cursor = j + 1;
    }
  } catch (e) {
    if (e instanceof AgentMiddlewareError) throw e;
    throw new AgentMiddlewareError(hook, name, { cause: e });
  }
  return Object.freeze({
    text: text as string,
    toolCalls: Object.freeze(calls),
  });
}

/** A fresh frozen copy of a message (each field read once), or undefined if it is not a valid AgentMessage. */
function snapshotMessage(m: unknown): AgentMessage | undefined {
  if (m === null || typeof m !== 'object') return undefined;
  const x = m as Record<string, unknown>;
  const role = x.role,
    content = x.content,
    toolCallId = x.toolCallId,
    name = x.name;
  if (
    typeof role !== 'string' ||
    !ROLES.has(role) ||
    typeof content !== 'string'
  )
    return undefined;
  if (
    (toolCallId !== undefined && typeof toolCallId !== 'string') ||
    (name !== undefined && typeof name !== 'string')
  )
    return undefined;
  const out: {
    role: AgentRole;
    content: string;
    toolCallId?: string;
    name?: string;
  } = { role: role as AgentRole, content };
  if (toolCallId !== undefined) out.toolCallId = toolCallId;
  if (name !== undefined) out.name = name;
  return Object.freeze(out);
}

/** Prompt-cache fields (module 019f) the terminal carries through to the model; see snapshotCacheFields. */
interface CacheFields {
  readonly promptTier: 'static' | 'workspace';
  readonly cacheControl: { readonly type: 'ephemeral' };
  readonly cacheKey: string;
  readonly tools?: unknown;
}

/**
 * The prompt-cache fields of a message (each read once; tools deep-copied JSON data; all frozen), or undefined when
 * the message is not a well-formed cacheable-tier `system` message. Only messages in the leading run of such
 * messages keep them (no breakpoint after the first volatile message); every other field is dropped as before.
 */
function snapshotCacheFields(m: unknown): CacheFields | undefined {
  if (m === null || typeof m !== 'object') return undefined;
  const x = m as Record<string, unknown>;
  const role = x.role,
    promptTier = x.promptTier,
    cacheControl = x.cacheControl,
    cacheKey = x.cacheKey,
    tools = x.tools;
  if (
    role !== 'system' ||
    (promptTier !== 'static' && promptTier !== 'workspace') ||
    typeof cacheKey !== 'string' ||
    cacheKey.length === 0
  )
    return undefined;
  let cc: unknown;
  let t: unknown;
  try {
    cc = cloneJson(cacheControl, new Set());
    t = tools === undefined ? undefined : cloneJson(tools, new Set());
  } catch {
    return undefined;
  }
  if (cc === null || typeof cc !== 'object' || Array.isArray(cc))
    return undefined;
  const keys = Object.keys(cc);
  if (keys.length !== 1 || (cc as Record<string, unknown>).type !== 'ephemeral')
    return undefined;
  if (t !== undefined && !Array.isArray(t)) return undefined;
  const out: {
    promptTier: CacheFields['promptTier'];
    cacheControl: CacheFields['cacheControl'];
    cacheKey: string;
    tools?: unknown;
  } = {
    promptTier,
    cacheControl: Object.freeze({ type: 'ephemeral' as const }),
    cacheKey,
  };
  if (t !== undefined) out.tools = deepFreeze(t);
  return Object.freeze(out);
}

/** sha256 of the canonical JSON of a message's data plus its cache fields, or undefined if it has no valid ones. */
function cacheTierHash(
  m: unknown
): { snap: AgentMessage; cache: CacheFields; hash: string } | undefined {
  const snap = snapshotMessage(m);
  const cache = snapshotCacheFields(m);
  if (snap === undefined || cache === undefined) return undefined;
  let hash: string;
  try {
    hash = sha256Hex(canonicalJson({ ...snap, ...cache }));
  } catch {
    return undefined;
  }
  return { snap, cache, hash };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? 'null';
  } catch {
    return '"[unserializable]"';
  }
}

function toolResultContent(r: RouterResult): string {
  switch (r.status) {
    case 'ok':
      return `{"status":"ok","result":${safeJson(r.result)}}`;
    case 'needs_confirmation':
      return safeJson({ status: r.status, pendingId: r.pendingId });
    case 'denied':
      return safeJson({ status: r.status, reason: r.reason });
    case 'error':
      return safeJson({ status: r.status, message: r.message });
  }
}

/** True if the redactor would change `text` (a throwing or malformed redactor aborts the run). */
function redactorChanges(
  fn: (m: AgentMessage) => AgentMessage,
  name: string,
  text: string
): boolean {
  let out: unknown;
  try {
    out = fn(Object.freeze({ role: 'system', content: text }));
  } catch (e) {
    throw new AgentMiddlewareError('terminalRedact', name, { cause: e });
  }
  const snap = snapshotMessage(out);
  if (snap === undefined)
    throw new AgentMiddlewareError('terminalRedact', name, {
      cause: new Error('redactor returned a malformed message'),
    });
  return snap.content !== text || snap.role !== 'system';
}

function validateInput(input: AgentInput): Identity {
  for (const k of ['runId', 'userId', 'workspaceId', 'channel'] as const) {
    if (typeof input[k] !== 'string' || input[k].length === 0)
      throw new TypeError(`runAgent: input.${k} must be a non-empty string`);
  }
  if (!Array.isArray(input.messages) || !input.messages.every(isMessage))
    throw new TypeError('runAgent: input.messages is malformed');
  const id = Object.create(null) as {
    -readonly [K in keyof Identity]: Identity[K];
  };
  id.runId = input.runId;
  id.userId = input.userId;
  id.workspaceId = input.workspaceId;
  id.channel = input.channel;
  if (Object.hasOwn(input, 'mode') && input.mode !== undefined)
    id.mode = input.mode;
  return Object.freeze(id);
}

export async function runAgent(
  deps: AgentDeps,
  middlewares: readonly AgentMiddleware[],
  input: AgentInput
): Promise<AgentResult> {
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;
  if (
    !Number.isInteger(maxRounds) ||
    maxRounds < 1 ||
    maxRounds > MAX_ROUNDS_LIMIT
  ) {
    throw new RangeError(
      `runAgent: maxRounds must be an integer in 1..${MAX_ROUNDS_LIMIT}`
    );
  }
  const clock = deps.clock ?? systemClock;
  const mws = Object.freeze([...middlewares]);
  const identity = validateInput(input);
  // The router context comes from the input once; nothing a hook does to state reaches it.
  // Null prototype: a polluted Object.prototype.mode never reads through as ctx.mode.
  const ctxObj = Object.create(null) as {
    -readonly [K in keyof AssistContext]: AssistContext[K];
  };
  ctxObj.runId = identity.runId;
  ctxObj.userId = identity.userId;
  ctxObj.workspaceId = identity.workspaceId;
  if (identity.mode !== undefined) ctxObj.mode = identity.mode;
  const ctx: AssistContext = Object.freeze(ctxObj);
  const redactors = mws.flatMap((mw) =>
    typeof mw.terminalRedact === 'function'
      ? [{ mw, fn: mw.terminalRedact }]
      : []
  );
  const counts = {
    rounds: 0,
    toolsProposed: 0,
    toolsAllowed: 0,
    toolsRefused: 0,
    toolsPending: 0,
  };

  const state = Object.create(null) as AgentState;
  state.messages = input.messages.map((m) => ({ ...m }));
  for (const k of IDENTITY_KEYS) {
    if (identity[k] !== undefined)
      Object.defineProperty(state, k, {
        value: identity[k],
        enumerable: true,
        writable: false,
        configurable: false,
      });
  }
  Object.defineProperty(state, 'round', {
    get: () => counts.rounds,
    enumerable: true,
    configurable: false,
  });
  Object.seal(state);

  const checkState = (hook: HookName, name: string) => {
    for (const k of IDENTITY_KEYS) {
      if (state[k] !== identity[k])
        throw new AgentMiddlewareError(hook, name, {
          cause: new Error(`hook changed state.${k}`),
        });
    }
    if (!Array.isArray(state.messages) || !state.messages.every(isMessage)) {
      throw new AgentMiddlewareError(hook, name, {
        cause: new Error('hook left state.messages malformed'),
      });
    }
  };
  const runHook = async <T>(
    hook: HookName,
    mw: AgentMiddleware,
    fn: () => Awaitable<T>
  ): Promise<T> => {
    let out: T;
    try {
      out = await fn();
    } catch (e) {
      // An error from an inner layer of wrapModelCall (model or inner hook) keeps its own attribution.
      if (e instanceof AgentMiddlewareError || e instanceof AgentModelError)
        throw e;
      throw new AgentMiddlewareError(hook, mw.name, { cause: e });
    }
    checkState(hook, mw.name);
    return out;
  };

  const startedAt = clock.now();
  for (const mw of mws)
    if (mw.beforeAgent)
      await runHook('beforeAgent', mw, () => mw.beforeAgent!(state));

  let status: AgentResult['status'] = 'round_cap';
  let text = '';
  while (counts.rounds < maxRounds) {
    counts.rounds++;
    for (const mw of mws)
      if (mw.beforeModel)
        await runHook('beforeModel', mw, () => mw.beforeModel!(state));

    // The per-call registry of installed cacheable-tier messages (019f); written only through a CacheTierChannel.
    let installedCacheable: readonly {
      readonly message: AgentMessage;
      readonly hash: string;
    }[] = [];
    let installs = 0;
    const terminal = async (): Promise<ModelResponse> => {
      // Terminal redaction: after every wrap layer, immediately before the model, on a fresh snapshot.
      // Prompt-cache fields (019f) are kept only on the leading run of messages that are the very objects the
      // sanctioned installer registered for this call (identity AND canonical hash); everything else loses them.
      const cache: (CacheFields | undefined)[] = [];
      let leading = true;
      let msgs: AgentMessage[] = state.messages.map((m, i) => {
        const snap = snapshotMessage(m);
        if (snap === undefined)
          throw new AgentMiddlewareError('terminalRedact', 'pipeline', {
            cause: new Error('state.messages malformed'),
          });
        const reg = leading ? installedCacheable[i] : undefined;
        const h =
          reg !== undefined && reg.message === m ? cacheTierHash(m) : undefined;
        const keep = h !== undefined && h.hash === reg!.hash;
        if (!keep) leading = false;
        cache.push(keep ? h.cache : undefined);
        return snap;
      });
      if (cache.filter((c) => c !== undefined).length > MAX_CACHE_BREAKPOINTS) {
        throw new AgentMiddlewareError('terminalRedact', 'pipeline', {
          cause: new Error('too many cache breakpoints'),
        });
      }
      for (const { mw, fn } of redactors) {
        msgs = msgs.map((m, i) => {
          let out: unknown;
          try {
            out = fn(m);
          } catch (e) {
            throw new AgentMiddlewareError('terminalRedact', mw.name, {
              cause: e,
            });
          }
          const snap = snapshotMessage(out);
          if (snap === undefined)
            throw new AgentMiddlewareError('terminalRedact', mw.name, {
              cause: new Error('redactor returned a malformed message'),
            });
          // A cacheable-tier message must hold no redactable data: if redaction changes it, fail closed.
          const c = cache[i];
          if (c !== undefined) {
            const changed =
              snap.role !== m.role ||
              snap.content !== m.content ||
              snap.toolCallId !== m.toolCallId ||
              snap.name !== m.name;
            if (
              changed ||
              redactorChanges(fn, mw.name, c.cacheKey) ||
              (c.tools !== undefined &&
                redactorChanges(fn, mw.name, canonicalJson(c.tools)))
            ) {
              throw new AgentMiddlewareError('terminalRedact', mw.name, {
                cause: new Error('redaction changed a cacheable-tier message'),
              });
            }
          }
          return snap;
        });
      }
      msgs = msgs.map((m, i) => {
        const c = cache[i];
        return c === undefined ? m : Object.freeze({ ...m, ...c });
      });
      if (redactors.length > 0) state.messages = [...msgs];
      let raw: unknown;
      try {
        raw = await deps.model(
          Object.freeze({ messages: Object.freeze(msgs) })
        );
      } catch (e) {
        throw new AgentModelError('model call failed', { cause: e });
      }
      const resp = freezeModelResponse(raw);
      counts.toolsProposed += resp.toolCalls.length;
      return resp;
    };
    let call = terminal;
    for (let i = mws.length - 1; i >= 0; i--) {
      const mw = mws[i]!;
      if (!mw.wrapModelCall) continue;
      const inner = call;
      const sanctioned = SANCTIONED_CACHE_INSTALLERS.has(mw);
      call = async () => {
        let used = false;
        let expired = false;
        // What the inner layer returned: the only calls this layer may keep (none if it never got a response).
        let innerOut: ModelResponse | undefined;
        const next = (): Promise<ModelResponse> => {
          if (expired)
            return Promise.reject(
              new AgentMiddlewareError('wrapModelCall', mw.name, {
                cause: new Error('next() called after wrapModelCall returned'),
              })
            );
          if (used)
            return Promise.reject(
              new AgentMiddlewareError('wrapModelCall', mw.name, {
                cause: new Error('next() called twice'),
              })
            );
          used = true;
          return inner().then((r) => {
            innerOut = r;
            return r;
          });
        };
        const channel: CacheTierChannel | undefined = sanctioned
          ? Object.freeze({
              install(messages: readonly AgentMessage[]): void {
                const fail = (why: string) =>
                  new AgentMiddlewareError('wrapModelCall', mw.name, {
                    cause: new Error(why),
                  });
                if (expired)
                  throw fail(
                    'cache tier channel used after wrapModelCall returned'
                  );
                if (installs++ > 0)
                  throw fail('cache tiers installed twice in one model call');
                if (
                  !Array.isArray(messages) ||
                  messages.length > MAX_CACHE_BREAKPOINTS
                )
                  throw fail('bad cache tier install');
                const reg = messages.map((message) => {
                  const h = cacheTierHash(message);
                  if (h === undefined || !Object.isFrozen(message))
                    throw fail('bad cache tier message');
                  return Object.freeze({ message, hash: h.hash });
                });
                installedCacheable = Object.freeze(reg);
              },
            })
          : undefined;
        let out: ModelResponse;
        try {
          out = await runHook('wrapModelCall', mw, () =>
            mw.wrapModelCall!(state, next, channel)
          );
        } finally {
          expired = true;
        }
        return snapshotResponse(
          out,
          innerOut?.toolCalls ?? [],
          'wrapModelCall',
          mw.name
        );
      };
    }
    let response = await call();
    for (let i = mws.length - 1; i >= 0; i--) {
      const mw = mws[i]!;
      if (!mw.afterModel) continue;
      const current = response;
      const out = await runHook('afterModel', mw, () =>
        mw.afterModel!(state, current)
      );
      if (out !== undefined)
        response = snapshotResponse(
          out,
          current.toolCalls,
          'afterModel',
          mw.name
        );
    }

    text = response.text;
    state.messages = [
      ...state.messages,
      { role: 'assistant', content: response.text },
    ];
    if (response.toolCalls.length === 0) {
      status = 'completed';
      break;
    }
    // Tool step: the router is the terminal; it alone runs the guard, the confirmation gate and the handler.
    for (const c of response.toolCalls) {
      const r = await deps.router.execute(ctx, {
        tool: c.tool,
        args: c.args,
        ...(c.pendingId !== undefined ? { pendingId: c.pendingId } : {}),
      });
      if (r.status === 'ok' || r.status === 'error') counts.toolsAllowed++;
      else if (r.status === 'denied') counts.toolsRefused++;
      else counts.toolsPending++;
      state.messages = [
        ...state.messages,
        {
          role: 'tool',
          toolCallId: c.id,
          name: c.tool,
          content: toolResultContent(r),
        },
      ];
    }
  }

  const result: AgentResult = Object.freeze({
    status,
    text,
    messages: Object.freeze(state.messages.map((m) => Object.freeze({ ...m }))),
    counts: Object.freeze({ ...counts }),
    startedAt,
    finishedAt: clock.now(),
  });
  for (let i = mws.length - 1; i >= 0; i--) {
    const mw = mws[i]!;
    if (mw.afterAgent)
      await runHook('afterAgent', mw, () => mw.afterAgent!(state, result));
  }
  return result;
}
