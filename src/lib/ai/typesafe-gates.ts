import { getDecisionLayer, type DecisionLayer } from '@/lib/typesafe';
import { PARTNER_BANK_DISPLAY } from '@/lib/typesafe/banks';
import {
  accountEnabled,
  isShadow,
  type CheckName,
  type CheckState,
} from '@/lib/typesafe/config';
import { supabaseAdmin } from './admin-client';
import type { KnowledgeRetrieval } from './knowledge';
import type { ChatMessage } from './types';

// ============================================================
// The TypeSafe decision layer (lib/typesafe, migration 063) as three
// gates on the auto-reply bot — hooks R1–R3 of module 013:
//
//   triage    — before any LLM spend: may hand the thread to a person
//               (a human request, a possible complaint, an opt-out) or
//               restrict the bot to the knowledge base
//   passages  — after retrieval: drops irrelevant / injected excerpts
//               and sets contradicting ones apart
//   guardrail — immediately before the send: may hold or block the
//               drafted reply
//
// Each one follows the layer's host rule: a decision with `act: false`
// (monitor mode, TypeSafe down, a language kept logged-only) changes
// nothing, so the bot behaves exactly as it did before 063. Whether a
// check runs at all is the account's own switch in Settings → AI safety
// checks (migration 064), within what the install allows. A check that
// is off is not called — no TypeSafe request, no policy read, no log row
// — and neither is anything when the TS_* configuration is invalid (the
// layer logs that loudly and stays off, except for the guardrail's
// fail-safe below).
//
// A check in monitor mode cannot change the reply, so it is not awaited
// on the reply's path: it is handed to `defer`, which the dispatcher
// awaits at the very end — still inside the webhook's after(), so nothing
// is left floating.
//
// The pre-eligibility check (hook R4) has no host step in this app and
// is not wired; it is exported from lib/typesafe for when one exists.
// ============================================================

export interface TsRef {
  accountId: string;
  conversationId: string;
  contactId: string;
  /** Gateway id of the inbound message (hashed before it is logged). */
  messageId?: string | null;
  /** Collects shadow work to await after the reply. Without it, shadow
   *  checks are awaited inline. */
  defer?: (work: Promise<unknown>) => void;
}

/** The layer and the check's state, when `check` runs for this account. */
async function layerFor(
  check: CheckName,
  accountId: string
): Promise<{ ts: DecisionLayer; state: CheckState } | null> {
  const ts = getDecisionLayer();
  if (!ts || !ts.config.enabled[check]) return null;
  const state = await ts.state(check, accountId);
  return state.on ? { ts, state } : null;
}

/**
 * Runs `work` inline, or — when the check is in monitor mode and the
 * caller can defer — in the background of the dispatch, returning `today`
 * at once. Monitoring never changes the outcome, so this is purely latency.
 */
async function inlineOrDeferred<T>(
  state: CheckState,
  check: CheckName,
  ref: TsRef,
  work: () => Promise<T>,
  today: T
): Promise<T> {
  if (ref.defer && state.monitor) {
    ref.defer(
      work().catch((err) =>
        console.error(`[ts013] shadow ${check} failed:`, err)
      )
    );
    return today;
  }
  return work();
}

/** How many earlier turns the triage state carries (the layer caps at 6). */
const TRIAGE_TURNS = 6;

export interface TriageGateResult {
  /** Hand the thread to a person instead of answering. `farewell` is
   *  false for an opt-out: someone who asked us to stop must not get a
   *  "a colleague will follow up" message. `optOut` says whether the
   *  customer asked us to stop writing (record) or may have (review). */
  handoff: {
    detail: string;
    farewell: boolean;
    optOut: 'record' | 'suppress_pending_review' | 'none';
  } | null;
  /** The message tried to steer the assistant: answer from the
   *  knowledge base only. */
  restricted: boolean;
  /** Extra system-prompt lines for this reply. */
  promptNotes: string[];
}

const NO_TRIAGE: TriageGateResult = {
  handoff: null,
  restricted: false,
  promptNotes: [],
};

/**
 * The conversation before `message`: everything ahead of the last
 * customer turn that says it. A message the context doesn't hold (a media
 * caption) has the whole context before it. A later customer message that
 * already arrived is not "before" it, and is left out.
 */
export function turnsBefore(
  messages: ChatMessage[],
  message: string
): ChatMessage[] {
  const want = message.trim();
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user' && messages[i]!.content.trim() === want)
      return messages.slice(0, i);
  }
  return messages;
}

/**
 * Checks A + B — inbound triage and the opt-out safety net, one
 * TypeSafe request. `journeyStage` is what this app knows about where
 * the customer is: in a guided flow, answering a campaign, or neither.
 */
export async function runTriageGate(
  ref: TsRef,
  args: {
    messages: ChatMessage[];
    question: string;
    journeyStage: string;
    /** The message to judge — the one that triggered the dispatch — when
     *  the caller has it (it may be a media caption the text context
     *  leaves out). Defaults to `question`, the latest customer message. */
    customerTurn?: string;
  }
): Promise<TriageGateResult> {
  const on = await layerFor('triage', ref.accountId);
  if (!on) return NO_TRIAGE;
  const { ts } = on;

  const message = args.customerTurn?.trim() || args.question;
  const before = turnsBefore(args.messages, message);
  const d = await inlineOrDeferred(
    on.state,
    'triage',
    ref,
    () =>
      ts.triage({
        accountId: ref.accountId,
        conversationId: ref.conversationId,
        contactId: ref.contactId,
        messageId: ref.messageId,
        message,
        recentTurns: before.slice(-TRIAGE_TURNS).map((m) => ({
          from: m.role === 'user' ? 'customer' : 'taamul',
          text: m.content,
        })),
        journeyStage: args.journeyStage,
      }),
    null
  );
  if (!d || !d.act) return NO_TRIAGE;

  if (d.route === 'opted_out' || d.route === 'rm') {
    const reasons =
      d.route === 'opted_out'
        ? ['OPT_OUT', ...(d.rmTask?.reasons ?? [])]
        : (d.rmTask?.reasons ?? d.reasonCodes);
    const priority =
      d.rmTask && d.rmTask.priority !== 'normal'
        ? `, ${d.rmTask.priority}`
        : '';
    return {
      handoff: {
        detail: `${reasons.join(', ')}${priority}`,
        // A possible opt-out (review band) keeps the bot silent too.
        farewell: d.optOut === 'none',
        optOut: d.optOut,
      },
      restricted: false,
      promptNotes: [],
    };
  }

  const promptNotes: string[] = [];
  if (d.nonPartnerBank.detected) {
    // The guardrail blocks any reply naming a non-partner bank, a polite
    // refusal included — so the model is told not to name one at all.
    promptNotes.push(
      `The customer is asking about a bank the business does not work with. Say only that you can help with the partner banks (${PARTNER_BANK_DISPLAY.join(', ')}). Do not name, describe or compare any other bank, not even to decline it.`
    );
  }
  return {
    handoff: null,
    restricted: d.route === 'bot_restricted',
    promptNotes,
  };
}

export interface PassageGateResult {
  /** Excerpts to ground the reply in. */
  knowledge: string[];
  /** Relevant excerpts that contradict the customer's premise. */
  conflicts: string[];
  /** Every excerpt the prompt was built from, by chunk id — exactly what
   *  the guardrail must check the reply's figures against. */
  evidence: { id: string; text: string }[];
  /** Retrieval as the retrieval gate should judge it: after filtering,
   *  when the filter acted. */
  retrieval: KnowledgeRetrieval;
}

/** Check D — screen the retrieved excerpts before they reach the prompt. */
export async function runPassageGate(
  ref: TsRef,
  args: { query: string; retrieval: KnowledgeRetrieval }
): Promise<PassageGateResult> {
  const { retrieval } = args;
  const today: PassageGateResult = {
    knowledge: retrieval.excerpts,
    conflicts: [],
    evidence: retrieval.passages.map((p) => ({ id: p.id, text: p.content })),
    retrieval,
  };

  const on = await layerFor('passages', ref.accountId);
  if (!on || retrieval.passages.length === 0) return today;
  const { ts } = on;

  const d = await inlineOrDeferred(
    on.state,
    'passages',
    ref,
    () =>
      ts.passages({
        accountId: ref.accountId,
        conversationId: ref.conversationId,
        contactId: ref.contactId,
        messageId: ref.messageId,
        query: args.query,
        passages: retrieval.passages.map((p) => ({
          id: p.id,
          title: '',
          text: p.content,
          sourceType: 'knowledge_base',
          // Lexical hits have no score; they rank behind the semantic
          // ones, in retrieval order.
          similarity: p.similarity ?? 0,
        })),
      }),
    null
  );
  if (!d || !d.act) return today;

  const knowledge = d.evidence.map((p) => p.text);
  const conflicts = d.conflicts.map((p) => p.text);
  const keptIds = new Set([...d.evidence, ...d.conflicts].map((p) => p.id));
  const kept = retrieval.passages.filter((p) => keptIds.has(p.id));
  // The retrieval gate must judge what the prompt will actually hold: a
  // dropped passage's similarity no longer vouches for the answer. Scores
  // come from retrieval (null for lexical hits), not from the `?? 0`
  // ranking value above.
  const sims = kept
    .map((p) => p.similarity)
    .filter((s): s is number => s !== null);
  return {
    knowledge,
    conflicts,
    evidence: [...d.evidence, ...d.conflicts].map((p) => ({
      id: p.id,
      text: p.text,
    })),
    retrieval: {
      ...retrieval,
      passages: kept,
      excerpts: [...knowledge, ...conflicts],
      // Only lexical passages survived: keep the pre-filter score, so the
      // gate is never looser than it was without the filter (null would
      // switch it off).
      bestSimilarity: sims.length
        ? Math.max(...sims)
        : retrieval.bestSimilarity,
    },
  };
}

export type GuardrailGateResult =
  { outcome: 'send' } | { outcome: 'hold' | 'block'; detail: string };

/** Longest draft quoted into the internal hand-off note. */
const MAX_DRAFT_QUOTE = 300;

/**
 * Check C — screen a drafted free-text reply immediately before it is
 * sent. `hold` and `block` both mean: do not send it, hand the thread to
 * a person with the draft in the note (for review, or as the reason).
 * `context` is the other text the bot was told it may state facts from
 * (the business's instructions, the campaign message, the flow step).
 */
const quote = (text: string): string => {
  const draft = text.replace(/\s+/g, ' ').trim();
  return draft.length <= MAX_DRAFT_QUOTE
    ? draft
    : `${draft.slice(0, MAX_DRAFT_QUOTE - 1).trimEnd()}…`;
};

const TRUE = /^(1|true|yes|on)$/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The layer is up, but this account's switches could not be read and
 * none were read before in this process (a database error right after a
 * restart). The account might be running the guardrail live, so the
 * draft is held — the same fail-safe as an invalid configuration — unless
 * the install itself would never act: the guardrail is off here, forced
 * monitor-only, not allowed for the account, or set to send on failure.
 */
async function guardrailWhenSwitchesUnknown(
  accountId: string
): Promise<boolean> {
  const ts = getDecisionLayer();
  if (!ts || !ts.config.enabled.guardrail) return false;
  if (ts.config.guardrailFailMode === 'send') return false;
  // Only the install's own monitor-only counts: the unknown switches
  // say nothing about the account's mode.
  if (isShadow(ts.config, 'guardrail')) return false;
  if (!accountEnabled(ts.config, accountId)) return false;
  return (await ts.state('guardrail', accountId)).unknown;
}

const FALSE = /^(0|false|no|off)$/i;

/**
 * The TS_* configuration is unreadable, so the layer is off — but a
 * guardrail an account switched on and to Live must not start sending
 * unscreened replies over one typo in a server variable (the guardrail's
 * fail-safe rule). This reads only the raw overrides it needs and that
 * account's settings row: drafts are held exactly where the guardrail
 * would have been acting, and nowhere else.
 */
export async function guardrailWhenConfigInvalid(
  accountId: string,
  env: Record<string, string | undefined> = process.env
): Promise<boolean> {
  // The install switched the guardrail off, or chose "send" on failure.
  const enabled = env.TS_ENABLED_GUARDRAIL?.trim() ?? '';
  if (FALSE.test(enabled)) return false;
  // No key and not asked for explicitly: the guardrail was never
  // available here.
  if (!env.TYPESAFE_API_KEY?.trim() && !TRUE.test(enabled)) return false;
  if ((env.TS_GUARDRAIL_FAIL_MODE?.trim().toLowerCase() ?? '') === 'send')
    return false;
  // The install forces monitor-only.
  const forced = env.TS_SHADOW_GUARDRAIL?.trim() || env.TS_SHADOW?.trim() || '';
  if (TRUE.test(forced)) return false;
  // An account list that parses and leaves this account out. One that
  // does not parse (an inline comment, say) may be the very reason the
  // configuration is invalid, so it proves nothing: read the settings.
  const accounts = env.TS_ACCOUNT_IDS?.trim();
  if (accounts && accounts !== '*') {
    const ids = accounts
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    if (
      ids.every((id) => UUID.test(id)) &&
      !ids.includes(accountId.toLowerCase())
    )
      return false;
  }
  try {
    const { data, error } = await supabaseAdmin()
      .from('ts_account_settings')
      .select('enabled, guardrail, mode')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) {
      // No table: migration 064 was never applied, so nothing was ever
      // switched on. Any other read error: fail closed.
      return !['42P01', 'PGRST205'].includes(error.code ?? '');
    }
    const row = data as {
      enabled: boolean;
      guardrail: boolean;
      mode: string;
    } | null;
    return !!row && row.enabled && row.guardrail && row.mode === 'live';
  } catch {
    return true;
  }
}

export async function runGuardrailGate(
  ref: TsRef,
  args: {
    customerMessage: string;
    botReply: string;
    evidence: { id: string; text: string }[];
    context?: string[];
  }
): Promise<GuardrailGateResult> {
  if (!getDecisionLayer()) {
    return (await guardrailWhenConfigInvalid(ref.accountId))
      ? {
          outcome: 'hold',
          detail: `draft reply held: the TypeSafe configuration is invalid (CONFIG_INVALID), so it could not be screened. Draft: “${quote(args.botReply)}”`,
        }
      : { outcome: 'send' };
  }
  const on = await layerFor('guardrail', ref.accountId);
  if (!on) {
    return (await guardrailWhenSwitchesUnknown(ref.accountId))
      ? {
          outcome: 'hold',
          detail: `draft reply held: this account's AI safety settings could not be read (SETTINGS_LOAD), so it could not be screened. Draft: “${quote(args.botReply)}”`,
        }
      : { outcome: 'send' };
  }
  const { ts } = on;

  const g = await inlineOrDeferred(
    on.state,
    'guardrail',
    ref,
    () =>
      ts.guardrail({
        accountId: ref.accountId,
        conversationId: ref.conversationId,
        contactId: ref.contactId,
        messageId: ref.messageId,
        ...args,
      }),
    null
  );
  if (!g || !g.act || g.outcome === 'send') return { outcome: 'send' };

  const verb = g.outcome === 'block' ? 'blocked' : 'held for review';
  const codes = g.reasonCodes.length ? ` (${g.reasonCodes.join(', ')})` : '';
  return {
    outcome: g.outcome,
    detail: `draft reply ${verb}${codes}. Draft: “${quote(args.botReply)}”`,
  };
}
