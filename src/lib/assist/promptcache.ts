/**
 * Ported from wacrm module 019f (assistant prompt caching), reference package 2026-10-20 (src/assist/promptcache.ts). Pure TS;
 * only imports were adapted (wacrm module paths). "workspace" (workspaceId) is the wacrm account id.
 *
 * Assistant prompt caching (module 019f). One more 019e middleware; no new package, no network.
 *
 * The model request is laid out in three tiers, always in this order:
 *   1. STATIC     system instructions + tool / registry definitions. Identical for every workspace, user and turn.
 *                 One message, marked as a cache breakpoint.
 *   2. WORKSPACE  per-workspace policy text. One message (omitted when a workspace has no policy), marked as a
 *                 cache breakpoint whose key includes the workspaceId.
 *   3. VOLATILE   everything else: memory snippets, summary, conversation turns, tool results. Never cacheable.
 * Rules (each one fails closed with a PromptCacheError; inside runAgent that aborts the run per 019e):
 *   - STATIC and WORKSPACE text comes only from a closed allowlist of caller-supplied constant strings (looked up by
 *     id) and the tool definitions. Text holding a registered volatile marker, or a line taken from any message of the
 *     run, is refused.
 *   - Text with redactor-detectable personal data (src/lib/memory/redact.ts) is never marked cacheable: refused.
 *   - At most 2 breakpoints (static, workspace); no breakpoint on or after the first volatile message. Cache fields a
 *     volatile message arrives with are stripped.
 *   - staticPrefixHash = sha256 of the static tier (instructions + canonical tool definitions); a changed registry
 *     changes it. Only the hash is exposed for observability; content is never logged.
 * The breakpoint is the neutral field `cacheControl: { type: "ephemeral" }` on a message. Mapping it to a provider's
 * cache_control (and the static message's `tools` to the provider's tools parameter) is the model client's job and is
 * UNVERIFIED against any provider. Cache accounting reads only counts the model client returns as
 * `usage: { cacheReadTokens, cacheWriteTokens }` on its raw response (see wrapModel); they reach the existing
 * agent_run audit row (jsonb detail, no schema change) through auditSink.
 * The middleware never changes state identity, a message's role / toolCallId / name / content, or a tool call: the tier
 * layout exists only for the duration of the inner model call, then state.messages is restored (or, if the pipeline
 * replaced it, e.g. 019e terminal redaction, rebuilt from its current messages without tier messages or cache fields).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalJson, sha256Hex, type JsonValue } from './canonical';
import {
  SUMMARY_PREFIX,
  type AgentRunAuditRow,
  type AgentRunAuditSink,
} from './middleware.builtin';
import {
  sanctionCacheTierInstaller,
  type AgentMessage,
  type AgentMiddleware,
  type AgentState,
  type CacheTierChannel,
  type ModelCall,
  type ModelResponse,
} from './middleware';
import {
  redact as defaultRedact,
  type RedactResult,
} from '@/lib/memory/redact';
import {
  FOOTER as MEMORY_FOOTER,
  HEADER as MEMORY_HEADER,
} from '@/lib/memory/render';

export const MAX_BREAKPOINTS = 2;
/** A line at least this long shared (either way round) by cacheable text and a message means the text came from it. */
export const MIN_SHARED_LINE_CHARS = 24;
/** Markers of volatile content (memory block, summary, offloaded doc); always applied, callers may add more. */
export const DEFAULT_VOLATILE_MARKERS: readonly string[] = Object.freeze([
  MEMORY_HEADER,
  MEMORY_FOOTER,
  SUMMARY_PREFIX,
  '[doc:',
]);
export const TOOLS_HEADER = '<<<TOOL_DEFINITIONS>>>';
const MAX_TRACKED_RUNS = 1024;
/** A workspaceId longer than this, or holding a control / line-separator character, is invalid_config. */
export const MAX_WORKSPACE_ID_CHARS = 128;

export type PromptTier = 'static' | 'workspace';
export interface CacheControl {
  readonly type: 'ephemeral';
}
export interface PromptToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: JsonValue;
}
/** A message of a cacheable tier. Volatile messages are plain AgentMessages without any of these fields. */
export interface CachedMessage extends AgentMessage {
  readonly promptTier: PromptTier;
  readonly cacheControl: CacheControl;
  readonly cacheKey: string;
  readonly tools?: readonly PromptToolDefinition[];
}

export type PromptCacheErrorCode =
  | 'invalid_config'
  | 'unknown_constant'
  | 'volatile_in_cacheable_tier'
  | 'pii_in_cacheable_tier'
  | 'breakpoint_layout';

/** Never carries prompt text: only a code and the tier. */
export class PromptCacheError extends Error {
  constructor(
    readonly code: PromptCacheErrorCode,
    readonly tier?: PromptTier
  ) {
    super(`prompt cache refused (${code}${tier ? `, ${tier} tier` : ''})`);
    this.name = 'PromptCacheError';
  }
}

export interface CachedPromptParts {
  /** Closed allowlist: id -> constant text. */
  readonly constants: Readonly<Record<string, string>>;
  /** Ids of the STATIC system-instruction constants, in order. */
  readonly staticIds: readonly string[];
  readonly tools: readonly PromptToolDefinition[];
  /** WORKSPACE tier: the workspace and the ids of its policy constants (none: no workspace message). */
  readonly workspace: {
    readonly workspaceId: string;
    readonly policyIds: readonly string[];
  };
  /** The run's messages; they form the VOLATILE tier, in order. */
  readonly volatile: readonly AgentMessage[];
  /** Added to DEFAULT_VOLATILE_MARKERS. */
  readonly volatileMarkers?: readonly string[];
  readonly redactor?: (text: string) => RedactResult;
}

export interface CachedPrompt {
  readonly messages: readonly AgentMessage[];
  readonly staticPrefixHash: string;
  readonly workspaceCacheKey?: string;
  readonly breakpoints: number;
}

const CACHE_FIELDS = [
  'promptTier',
  'cacheControl',
  'cacheKey',
  'tools',
] as const;
const EPHEMERAL: CacheControl = Object.freeze({ type: 'ephemeral' as const });

function lookup(
  constants: Readonly<Record<string, string>>,
  ids: readonly string[],
  tier: PromptTier
): string[] {
  if (!Array.isArray(ids)) throw new PromptCacheError('invalid_config', tier);
  return ids.map((id) => {
    const text =
      typeof id === 'string' &&
      Object.prototype.hasOwnProperty.call(constants, id)
        ? constants[id]
        : undefined;
    if (typeof text !== 'string' || text.length === 0)
      throw new PromptCacheError('unknown_constant', tier);
    return text;
  });
}

function sortedTools(
  tools: readonly PromptToolDefinition[]
): PromptToolDefinition[] {
  if (!Array.isArray(tools))
    throw new PromptCacheError('invalid_config', 'static');
  const seen = new Set<string>();
  const out = tools.map((t) => {
    if (
      t === null ||
      typeof t !== 'object' ||
      typeof t.name !== 'string' ||
      t.name.length === 0 ||
      typeof t.description !== 'string' ||
      seen.has(t.name)
    ) {
      throw new PromptCacheError('invalid_config', 'static');
    }
    seen.add(t.name);
    let inputSchema: JsonValue | undefined;
    try {
      // Canonical deep copy: later changes to the caller's schema object cannot reach the static prefix.
      inputSchema =
        t.inputSchema === undefined
          ? undefined
          : (JSON.parse(canonicalJson(t.inputSchema)) as JsonValue);
    } catch {
      throw new PromptCacheError('invalid_config', 'static');
    }
    return deepFreeze({
      name: t.name,
      description: t.description,
      ...(inputSchema !== undefined ? { inputSchema } : {}),
    });
  });
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v))
      deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** Every string (keys included) of a JSON value, decoded: the tool text as a message could quote it. */
function jsonStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => jsonStrings(x, out));
  else if (v !== null && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) (out.push(k), jsonStrings(x, out));
  return out;
}

/** Comparison form: format / zero-width chars removed, NFKC, case-folded, whitespace collapsed. */
export function normaliseForSharedText(s: string): string {
  const noFormat = s.replace(/[\p{Cf}\u200B-\u200D\u2060\uFEFF]/gu, '');
  const folded = noFormat
    .normalize('NFKC')
    .toUpperCase()
    .toLowerCase()
    .normalize('NFKC');
  return folded
    .replace(/[\p{Cf}\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** True if the two (normalised) texts share a run of at least MIN_SHARED_LINE_CHARS code points. */
function sharesRun(windows: ReadonlySet<string>, text: string): boolean {
  const cps = Array.from(text);
  for (let i = 0; i + MIN_SHARED_LINE_CHARS <= cps.length; i++) {
    if (windows.has(cps.slice(i, i + MIN_SHARED_LINE_CHARS).join('')))
      return true;
  }
  return false;
}

function runWindows(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    const cps = Array.from(t);
    for (let i = 0; i + MIN_SHARED_LINE_CHARS <= cps.length; i++)
      out.add(cps.slice(i, i + MIN_SHARED_LINE_CHARS).join(''));
  }
  return out;
}

/** The STATIC tier text: instructions, then the canonical tool definitions. Depends on nothing per run. */
function staticText(
  instructions: readonly string[],
  tools: readonly PromptToolDefinition[]
): string {
  let toolsJson: string;
  try {
    toolsJson = canonicalJson(tools);
  } catch {
    throw new PromptCacheError('invalid_config', 'static');
  }
  return `${instructions.join('\n\n')}\n\n${TOOLS_HEADER}\n${toolsJson}`;
}

const prefixHash = (m: { role: string; content: string }): string =>
  sha256Hex(canonicalJson({ role: m.role, content: m.content }));

/**
 * Refuses cacheable text holding a volatile marker or text taken from a message, or personal data. "Taken from" is
 * any run of at least MIN_SHARED_LINE_CHARS characters shared by the normalised cacheable text (and the JSON-decoded
 * tool strings, `extra`) and a normalised message: this covers a whole line either way round and a partial overlap.
 */
function checkCacheable(
  text: string,
  tier: PromptTier,
  parts: CachedPromptParts,
  extra: readonly string[] = []
): void {
  for (const marker of [
    ...DEFAULT_VOLATILE_MARKERS,
    ...(parts.volatileMarkers ?? []),
  ]) {
    if (
      typeof marker === 'string' &&
      marker.length > 0 &&
      text.includes(marker)
    )
      throw new PromptCacheError('volatile_in_cacheable_tier', tier);
  }
  const windows = runWindows([text, ...extra].map(normaliseForSharedText));
  for (const m of parts.volatile) {
    if (sharesRun(windows, normaliseForSharedText(m.content)))
      throw new PromptCacheError('volatile_in_cacheable_tier', tier);
  }
  let r: RedactResult;
  try {
    r = (parts.redactor ?? defaultRedact)(text);
  } catch {
    throw new PromptCacheError('pii_in_cacheable_tier', tier);
  }
  if (r === null || typeof r !== 'object' || r.ok !== true || r.text !== text)
    throw new PromptCacheError('pii_in_cacheable_tier', tier);
}

/** A volatile message never carries a cache field: copy it without them (role / content / toolCallId / name kept). */
function stripCacheFields(m: AgentMessage): AgentMessage {
  const x = m as unknown as Record<string, unknown>;
  if (!CACHE_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(x, k)))
    return m;
  const copy: Record<string, unknown> = { ...x };
  for (const k of CACHE_FIELDS) delete copy[k];
  return Object.freeze(copy) as unknown as AgentMessage;
}

const bodyHash = (m: AgentMessage): string =>
  sha256Hex(canonicalJson({ role: m.role, content: m.content }));

/**
 * The messages without the tier messages this call installed (matched by identity, or by the hash of their role and
 * content wherever they now stand, never by position); cache fields stripped from everything that remains.
 */
function untier(
  messages: readonly AgentMessage[],
  installed: readonly AgentMessage[]
): AgentMessage[] {
  const ids = new Set<AgentMessage>(installed);
  const hashes = new Set(installed.map(bodyHash));
  return messages
    .filter((m) => !ids.has(m) && !hashes.has(bodyHash(m)))
    .map(stripCacheFields);
}

const hasCacheFields = (m: AgentMessage): boolean =>
  CACHE_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(m, k));

function assertLayout(
  messages: readonly AgentMessage[],
  cacheable: number
): void {
  let breakpoints = 0;
  messages.forEach((m, i) => {
    if ((m as Partial<CachedMessage>).cacheControl !== undefined) {
      breakpoints++;
      if (i >= cacheable) throw new PromptCacheError('breakpoint_layout');
    }
  });
  if (breakpoints > MAX_BREAKPOINTS)
    throw new PromptCacheError('breakpoint_layout');
}

/** Pure: lays out the request in the fixed tier order and marks the (at most 2) breakpoints. Throws PromptCacheError. */
export function buildCachedPrompt(parts: CachedPromptParts): CachedPrompt {
  const workspaceId = parts.workspace?.workspaceId;
  if (
    typeof workspaceId !== 'string' ||
    workspaceId.length === 0 ||
    workspaceId.length > MAX_WORKSPACE_ID_CHARS ||
    /[\p{Cc}\u2028\u2029]/u.test(workspaceId) ||
    !Array.isArray(parts.volatile)
  ) {
    throw new PromptCacheError('invalid_config');
  }
  const tools = sortedTools(parts.tools);
  const sText = staticText(
    lookup(parts.constants, parts.staticIds, 'static'),
    tools
  );
  checkCacheable(sText, 'static', parts, jsonStrings(tools));
  const staticPrefixHash = prefixHash({ role: 'system', content: sText });
  const staticMsg: CachedMessage = Object.freeze({
    role: 'system',
    content: sText,
    promptTier: 'static',
    cacheControl: EPHEMERAL,
    cacheKey: `static:${staticPrefixHash}`,
    tools: Object.freeze(tools),
  });

  const tiers: CachedMessage[] = [staticMsg];
  let workspaceCacheKey: string | undefined;
  const policies = lookup(
    parts.constants,
    parts.workspace.policyIds,
    'workspace'
  );
  if (policies.length > 0) {
    const wText = `Workspace policy (workspace ${workspaceId}):\n${policies.join('\n\n')}`;
    checkCacheable(wText, 'workspace', parts);
    workspaceCacheKey = `workspace:${workspaceId}:${sha256Hex(wText)}`;
    tiers.push(
      Object.freeze({
        role: 'system',
        content: wText,
        promptTier: 'workspace',
        cacheControl: EPHEMERAL,
        cacheKey: workspaceCacheKey,
      })
    );
  }

  const volatile = parts.volatile.map(stripCacheFields);
  const messages = [...tiers, ...volatile];
  assertLayout(messages, tiers.length);
  return Object.freeze({
    messages: Object.freeze(messages),
    staticPrefixHash,
    ...(workspaceCacheKey !== undefined ? { workspaceCacheKey } : {}),
    breakpoints: tiers.length,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// middleware

export interface PromptCacheOptions {
  /** Closed allowlist: id -> constant text. Copied at construction; nothing else enters a cacheable tier. */
  readonly constants: Readonly<Record<string, string>>;
  readonly staticIds: readonly string[];
  readonly tools: readonly PromptToolDefinition[];
  /** Ids of the policy constants of a workspace (none or [] for no WORKSPACE tier). */
  readonly workspacePolicy?: (workspaceId: string) => readonly string[];
  readonly volatileMarkers?: readonly string[];
  readonly redactor?: (text: string) => RedactResult;
}

/** Counts only, summed over a run's model calls, from the usage the model client reports. */
export interface CacheUsage {
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
}

export interface PromptCacheMiddleware extends AgentMiddleware {
  /** sha256 of the STATIC tier (observability; content is never exposed). */
  readonly staticPrefixHash: string;
  /** Wrap deps.model so the provider usage counts (raw response `usage.cacheReadTokens / cacheWriteTokens`) are kept. */
  wrapModel(model: ModelCall): ModelCall;
  /** Removes and returns a run's cache counts. */
  takeCacheUsage(runId: string): CacheUsage | undefined;
  /** Wrap an agent_run audit sink: adds cache_read_tokens / cache_write_tokens to the row's detail (jsonb). */
  auditSink(sink: AgentRunAuditSink): AgentRunAuditSink;
}

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const clampedSum = (a: number, b: number): number =>
  Math.min(Number.MAX_SAFE_INTEGER, a + b);

export function promptCacheMiddleware(
  opts: PromptCacheOptions
): PromptCacheMiddleware {
  if (
    opts === null ||
    typeof opts !== 'object' ||
    opts.constants === null ||
    typeof opts.constants !== 'object'
  ) {
    throw new PromptCacheError('invalid_config');
  }
  const constants: Readonly<Record<string, string>> = Object.freeze({
    ...opts.constants,
  });
  const staticIds = Object.freeze([...opts.staticIds]);
  const tools = Object.freeze(sortedTools(opts.tools));
  const volatileMarkers = Object.freeze([...(opts.volatileMarkers ?? [])]);
  const staticPrefixHash = prefixHash({
    role: 'system',
    content: staticText(lookup(constants, staticIds, 'static'), tools),
  });
  const usage = new Map<string, { read: number; write: number }>();
  // Runs that reached a model call and have not finished (afterAgent, or an error out of the model call): never
  // evicted. Finished runs keep their counts until taken; beyond MAX_TRACKED_RUNS the oldest finished one is dropped.
  const inProgress = new Set<string>();
  const finished: string[] = [];
  const currentRun = new AsyncLocalStorage<string>();
  const finish = (runId: string) => {
    if (!inProgress.delete(runId) || !usage.has(runId)) return;
    finished.push(runId);
    while (finished.length > MAX_TRACKED_RUNS) {
      const old = finished.shift()!;
      if (!inProgress.has(old)) usage.delete(old);
    }
  };
  const take = (runId: string): CacheUsage | undefined => {
    const acc = usage.get(runId);
    if (!acc) return undefined;
    usage.delete(runId);
    const i = finished.indexOf(runId);
    if (i >= 0) finished.splice(i, 1);
    return Object.freeze({
      cache_read_tokens: acc.read,
      cache_write_tokens: acc.write,
    });
  };

  return sanctionCacheTierInstaller(
    Object.freeze({
      name: 'promptCache',
      staticPrefixHash,
      async wrapModelCall(
        state: AgentState,
        next: () => Promise<ModelResponse>,
        cacheTiers?: CacheTierChannel
      ): Promise<ModelResponse> {
        const original = state.messages;
        const policyIds = opts.workspacePolicy
          ? opts.workspacePolicy(state.workspaceId)
          : [];
        const built = buildCachedPrompt({
          constants,
          staticIds,
          tools,
          volatileMarkers,
          workspace: {
            workspaceId: state.workspaceId,
            policyIds: policyIds ?? [],
          },
          volatile: original,
          ...(opts.redactor ? { redactor: opts.redactor } : {}),
        });
        if (!usage.has(state.runId))
          usage.set(state.runId, { read: 0, write: 0 });
        if (!inProgress.has(state.runId)) {
          const i = finished.indexOf(state.runId);
          if (i >= 0) finished.splice(i, 1);
          inProgress.add(state.runId);
          // A run that aborts outside its model call never reaches afterAgent, so the in-progress set is bounded too:
          // past MAX_TRACKED_RUNS open runs the oldest open one (insertion order) is dropped with its counts.
          while (inProgress.size > MAX_TRACKED_RUNS) {
            const oldest = inProgress.values().next().value as string;
            inProgress.delete(oldest);
            usage.delete(oldest);
          }
        }
        const tiers = built.messages.slice(0, built.breakpoints);
        const installed = [...built.messages];
        // Only the exact objects registered here may keep cache fields at the 019e terminal step.
        cacheTiers?.install(tiers);
        state.messages = installed;
        try {
          return await currentRun.run(state.runId, next);
        } catch (e) {
          finish(state.runId);
          throw e;
        } finally {
          // Untouched since installed: put the caller's array back (minus any cache fields it arrived with). Replaced
          // by the pipeline (019e terminal redaction, or a wrap layer): keep its current (redacted) messages, minus the
          // installed tier messages and every cache field.
          state.messages =
            state.messages === installed
              ? original.some(hasCacheFields)
                ? original.map(stripCacheFields)
                : original
              : untier(state.messages, tiers);
        }
      },
      afterAgent(state: AgentState): void {
        finish(state.runId);
      },
      wrapModel(model: ModelCall): ModelCall {
        return async (request) => {
          const raw = await model(request);
          const runId = currentRun.getStore();
          const u = (
            raw as {
              usage?: { cacheReadTokens?: unknown; cacheWriteTokens?: unknown };
            } | null
          )?.usage;
          const acc = runId !== undefined ? usage.get(runId) : undefined;
          if (acc && u !== null && typeof u === 'object') {
            acc.read = clampedSum(acc.read, count(u.cacheReadTokens));
            acc.write = clampedSum(acc.write, count(u.cacheWriteTokens));
          }
          return raw;
        };
      },
      takeCacheUsage: take,
      auditSink(sink: AgentRunAuditSink): AgentRunAuditSink {
        return async (row: AgentRunAuditRow) => {
          const u = take(row.runId);
          await sink(
            u
              ? Object.freeze({
                  ...row,
                  detail: Object.freeze({ ...row.detail, ...u }),
                })
              : row
          );
        };
      },
    })
  );
}
