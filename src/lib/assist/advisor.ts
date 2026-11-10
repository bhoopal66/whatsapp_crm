/**
 * Ported from wacrm module 019d ("Jev Tool Advisor"), reference package 2026-10-18 (src/advisor/advise.ts), rebuilt on
 * the TypeSafe gateway (lib/typesafe/client.ts) as the `tool_advice` selection caller.
 *
 * IDLE: no assistant exists in this CRM, and nothing calls adviseTools (like 019a's guard and router).
 *
 * adviseTools({ accountId, text, tools, deps }) ranks which registered assistant tool might fit a piece of staff text:
 *   -> { status: 'ok', suggestions: [{ toolName, score }] }   best first, at most maxSuggestions
 *    | { status: 'off', suggestions: [] }                      account not allowed (TS_ACCOUNT_IDS) or no API key
 *    | { status: 'unavailable', suggestions: [] }              any failure: vault, gateway, model mismatch, a throw
 * SUGGESTIONS ONLY. It never calls a tool handler or the 019a router's execute(), and acting on a suggestion still goes
 * through the guard and its confirmation gate. Never throws.
 *
 * What leaves the process:
 *   - the text, tokenised through the vault first when one is given (019c: EID / IBAN / passport / phone / account
 *     values become '[KIND:vlt_...]'), then redactClipped; a vault refusal or throw sends nothing;
 *   - per candidate tool, ONE noul keyed by ordinal (t1 … tN) whose wording carries the tool's description,
 *     redacted and clipped. Never the tool's name or any id: ordinals are mapped back to names here.
 * Only tools registered in the 019a ToolRegistry, with a non-blank description, are offered (first
 * TOOL_ADVICE_MAX_CANDIDATES, one per name). No tools or blank text: no request, `ok` with no suggestions.
 *
 * A selection judgment, not a safety check: no account switch, policy or decision-log row; its own breaker.
 * An answer from another model than the pinned one is `unavailable`, never half-used.
 */
import { noul } from '@typesafe-ai/sdk';
import { clip, redactClipped } from '@/lib/typesafe/checks/common';
import type { TypeSafeGateway } from '@/lib/typesafe/client';
import { accountEnabled, type Ts013Config } from '@/lib/typesafe/config';
import {
  tokenizeSensitive,
  type TokenizeContext,
  type TokenVault,
} from '@/lib/vault/tokenize';
import type { ToolRegistry } from './registry';

/** Changing any wording below means a new version. */
export const TOOL_ADVICE_QS_VERSION = 'qs-tool-advice-v1';
export const TOOL_ADVICE_DEADLINE_MS = 3000;
export const TOOL_ADVICE_MAX_CANDIDATES = 20;
export const TOOL_ADVICE_MAX_TEXT_CHARS = 4000;
export const TOOL_ADVICE_MAX_DESCRIPTION_CHARS = 300;
export const TOOL_ADVICE_DEFAULT_SUGGESTIONS = 5;
const MAX_SUGGESTIONS_CAP = 20;

export interface AdvisorTool {
  /** Registry key. Never sent. */
  name: string;
  /** What the tool does, in plain words. Sent (redacted); it must not name the tool. */
  description: string;
}

export interface ToolSuggestion {
  readonly toolName: string;
  /** P(this tool does what the text asks), 0..1. */
  readonly score: number;
}

export interface ToolAdvice {
  readonly status: 'ok' | 'unavailable' | 'off';
  readonly suggestions: readonly ToolSuggestion[];
}

export interface AdvisorDeps {
  config: Ts013Config;
  gateway: Pick<TypeSafeGateway, 'ask'>;
  /** The 019a registry: the only source of which names may be suggested. */
  registry: Pick<ToolRegistry, 'spec'>;
  /** 019c vault, when configured: the text is tokenised before it is redacted. */
  vault?: { store: TokenVault; context: TokenizeContext } | null;
  maxSuggestions?: number;
  deadlineMs?: number;
}

export interface AdviseToolsInput {
  /** The tenant (gateway content accounting, TS_ACCOUNT_IDS). */
  accountId: string;
  text: string;
  tools: readonly AdvisorTool[];
  deps: AdvisorDeps;
}

function toolQuestion(description: string) {
  return noul(
    `Would the following assistant action do what the staff member asks for in \`request\`? ${description}`,
    {
      true: 'Carrying out this action is what `request` asks for, in any wording or language.',
      false:
        '`request` asks for something else, asks nothing, or only mentions the topic in passing.',
    }
  );
}

export type ToolAdviceQuestion = ReturnType<typeof toolQuestion>;

/** `{ t1 … tN }`: `t(k+1)` judges `names[k]`. Questions carry descriptions only. */
export function buildToolAdviceQuestions(
  tools: readonly AdvisorTool[],
  registry: Pick<ToolRegistry, 'spec'>
): { questions: Record<string, ToolAdviceQuestion>; names: string[] } {
  const questions: Record<string, ToolAdviceQuestion> = {};
  const names: string[] = [];
  for (const t of tools) {
    if (names.length >= TOOL_ADVICE_MAX_CANDIDATES) break;
    if (typeof t?.name !== 'string' || names.includes(t.name)) continue;
    if (!registry.spec(t.name).registered) continue;
    const description =
      typeof t.description === 'string' ? t.description.trim() : '';
    if (!description) continue;
    names.push(t.name);
    questions[`t${names.length}`] = toolQuestion(
      redactClipped(description, TOOL_ADVICE_MAX_DESCRIPTION_CHARS)
    );
  }
  return { questions, names };
}

const OFF: ToolAdvice = Object.freeze({
  status: 'off',
  suggestions: Object.freeze([]),
});
const UNAVAILABLE: ToolAdvice = Object.freeze({
  status: 'unavailable',
  suggestions: Object.freeze([]),
});
const NOTHING: ToolAdvice = Object.freeze({
  status: 'ok',
  suggestions: Object.freeze([]),
});

/** Never throws; never executes anything. */
export async function adviseTools(
  input: AdviseToolsInput
): Promise<ToolAdvice> {
  try {
    return await advise(input);
  } catch {
    return UNAVAILABLE;
  }
}

async function advise({
  accountId,
  text,
  tools,
  deps,
}: AdviseToolsInput): Promise<ToolAdvice> {
  if (!accountEnabled(deps.config, accountId)) return OFF;
  if (typeof text !== 'string' || text.trim() === '') return NOTHING;
  const { questions, names } = buildToolAdviceQuestions(
    tools ?? [],
    deps.registry
  );
  if (names.length === 0) return NOTHING;

  // Cap before the vault, so an oversized text is not scanned and vaulted.
  let outgoing = clip(text, TOOL_ADVICE_MAX_TEXT_CHARS);
  if (deps.vault) {
    const t = await tokenizeSensitive(
      outgoing,
      deps.vault.context,
      deps.vault.store
    );
    if (!t.ok) return UNAVAILABLE;
    outgoing = t.text;
  }
  const state = {
    request: redactClipped(outgoing, TOOL_ADVICE_MAX_TEXT_CHARS),
  };

  const res = await deps.gateway.ask(
    'tool_advice',
    state,
    questions,
    accountId,
    { deadlineMs: deps.deadlineMs ?? TOOL_ADVICE_DEADLINE_MS }
  );
  if (!res.ok) return res.errorCode === 'DISABLED' ? OFF : UNAVAILABLE;
  if (res.modelMismatch) return UNAVAILABLE;

  const answers = res.result.answers as unknown as Record<
    string,
    { noul?: unknown } | undefined
  >;
  const scored: ToolSuggestion[] = [];
  for (let k = 0; k < names.length; k++) {
    const p = answers[`t${k + 1}`]?.noul;
    // Half a judgment is never used.
    if (typeof p !== 'number' || !Number.isFinite(p)) return UNAVAILABLE;
    scored.push({ toolName: names[k]!, score: Math.max(0, Math.min(1, p)) });
  }
  const max = deps.maxSuggestions;
  const limit =
    Number.isInteger(max) && max! > 0
      ? Math.min(max!, MAX_SUGGESTIONS_CAP)
      : TOOL_ADVICE_DEFAULT_SUGGESTIONS;
  const suggestions = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => Object.freeze(s));
  return Object.freeze({
    status: 'ok',
    suggestions: Object.freeze(suggestions),
  });
}
