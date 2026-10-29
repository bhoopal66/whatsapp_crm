// ============================================================
// Smart insights on every inbound customer message
// (docs/jev-insights.md, "Customer insights").
//
// Runs at the very end of the inbound fan-out, after TypeSafe's opt-out
// watch, inside the webhook's after(): nothing the customer or the next
// message waits for. One Jev request per message at most:
//
//   * the customer signals (intent, urgency, lead temperature, upset,
//     wants a person) are lifted from the triage row the bot or the watch
//     already logged for this exact message when one exists for the
//     pinned model, and asked for only otherwise;
//   * with Customer insights on, the deep figures (sentiment, objections,
//     needs a reply, asks for a call back) are always asked;
//   * the chat-tag suggestion is asked over the workspace's own tags.
//
// What is stored is display data (the insight_* and suggested_* columns
// of migrations 147 and 153, and one conversation_insight_events row per
// judged message, service role only), plus the attention pin and its
// bell (./attention.ts). Nothing here sends, tags, assigns or opts
// anyone out. Never throws.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { buildConversationContext } from '@/lib/ai/context';
import { turnsBefore } from '@/lib/ai/typesafe-gates';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import {
  getDecisionLayer,
  type InsightsDeep,
  type InsightsJudgment,
  type InsightsSignals,
  type TagCatalogue,
  type TagSuggestion,
} from '@/lib/typesafe';
import { messageHash } from '@/lib/typesafe/log';
import { applyInsightAttention, type AttentionOutcome } from './attention';
import {
  attentionReason,
  INSIGHT_INTENT_KEYS,
  objectionsFrom,
  priorityOf,
  TAG_SUGGEST_MIN_P,
} from './bands';
import {
  getInsightSettings,
  insightsAvailable,
  type InsightSettings,
} from './settings';
import { attentionRulesFrom } from './settings-shape';

/** Earlier turns sent with the message, as the watch sends them. */
const RECENT_TURNS = 6;

/** Judged messages kept per chat in conversation_insight_events. */
export const INSIGHT_HISTORY_KEEP = 30;
/** At most this many older history rows are trimmed per judgment. */
const HISTORY_TRIM_BATCH = 100;

/** The chat's tags as they stood when the suggestion was decided. */
export interface ChatTagState {
  chatTagId: string | null;
  chatSubTagId: string | null;
  /** The last suggested main tag a person dismissed. */
  dismissedId: string | null;
}

export interface StoredSuggestion {
  mainId: string;
  /** null unless Jev was at least TAG_SUGGEST_MIN_P sure of the sub-tag. */
  subId: string | null;
  p: number;
}

export interface InboundInsightsOutcome {
  /** Why nothing ran, or null when it did. `error` covers a thrown
   *  failure part-way (logged); whatever was written before it stays. */
  skipped: 'blank' | 'unavailable' | 'off' | 'rate_limited' | 'error' | null;
  /** The settings this run used (null when it stopped before reading). */
  settings: InsightSettings | null;
  /** The signals came from the logged triage row, not a new request. */
  reusedTriage: boolean;
  /** The figures stored, from whichever source; null when none. */
  signals: InsightsSignals | null;
  /** The deep figures stored with them; null when not asked or none. */
  deep: InsightsDeep | null;
  /** The Jev judgment; null when none was requested. */
  judgment: InsightsJudgment | null;
  /** The judgment's tag answer (null when tags were off, the workspace has
   *  no main tags, or the judgment failed). */
  tag: TagSuggestion | null;
  /** The chat's tags, read only when tag suggestions are on. */
  chat: ChatTagState | null;
  /** Server time (ISO, ms) taken just before the chat's tags were read:
   *  the basis of the suggestion write and of automatic tagging. A write
   *  lands only if no decision moved `suggestion_basis_at` past it. Null
   *  when the tags were not read. */
  basisAt: string | null;
  signalsWritten: boolean;
  /** The per-message history row: stored, failed (logged), or null when
   *  no figures were judged. */
  history: 'stored' | 'failed' | null;
  /** The attention pin for this judgment; null when no reason held. */
  attention: AttentionOutcome | null;
  /** What happened to the suggestion columns. `superseded`: the
   *  compare-and-set found the chat moved on (tagged, dismissed, or a
   *  decision made after this run read the chat) and wrote nothing. */
  suggestion: 'stored' | 'cleared' | 'superseded' | 'untouched';
  stored: StoredSuggestion | null;
}

export interface InboundInsightsArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  /** Gateway id of the inbound message (what the triage log hashes). */
  messageId: string;
  /** The inbound's text (a media caption included). */
  text: string;
  /** created_at of the persisted inbound message: insight_at's value. */
  messageAt: string;
}

const isNum = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null;

/**
 * The five signals from a logged triage `answers` object, or null when it
 * is not the shape the triage question set writes (purged, failed, or
 * from an older question set).
 */
export function signalsFromTriageAnswers(
  answers: unknown
): InsightsSignals | null {
  if (!isObj(answers)) return null;
  const { intent, urgency, lead_temperature, dissatisfied, wants_human } =
    answers;
  if (!isObj(intent) || typeof intent.choice !== 'string') return null;
  const key = intent.choice;
  if (!(INSIGHT_INTENT_KEYS as readonly string[]).includes(key)) return null;
  const probs = isObj(intent.probabilities) ? intent.probabilities : null;
  const p = isNum(probs?.[key]) ? probs[key] : intent.confidence;
  const score = (x: unknown) => (isObj(x) && isNum(x.score) ? x.score : null);
  const noul = (x: unknown) => (isObj(x) && isNum(x.noul) ? x.noul : null);
  const u = score(urgency);
  const t = score(lead_temperature);
  const d = noul(dissatisfied);
  const w = noul(wants_human);
  if (!isNum(p) || u === null || t === null || d === null || w === null)
    return null;
  return {
    intent: { key: key as InsightsSignals['intent']['key'], p },
    urgency: u,
    leadTemp: t,
    upset: d,
    wantsHuman: w,
  };
}

interface TagRow {
  id: string;
  name: string;
  parent_id: string | null;
  sub_tag_title: string | null;
  ai_hint: string | null;
}

/** The workspace's chat tags in display order, as Jev's catalogue. */
export async function loadTagCatalogue(
  db: SupabaseClient,
  accountId: string
): Promise<TagCatalogue> {
  const { data, error } = await db
    .from('chat_tags')
    .select('id, name, parent_id, sub_tag_title, ai_hint')
    .eq('account_id', accountId)
    // Display order, as lib/chat-tags/tree.ts sorts.
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
    .order('name', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as TagRow[];
  const mains: TagCatalogue['mains'] = rows
    .filter((r) => r.parent_id === null)
    .map((r) => ({
      id: r.id,
      name: r.name,
      hint: r.ai_hint,
      subTitle: r.sub_tag_title,
      subs: [],
    }));
  const byId = new Map(mains.map((m) => [m.id, m]));
  for (const r of rows) {
    if (r.parent_id === null) continue;
    byId
      .get(r.parent_id)
      ?.subs.push({ id: r.id, name: r.name, hint: r.ai_hint });
  }
  return { mains };
}

/**
 * What the chat should suggest after this judgment, or null for "no
 * suggestion" (the caller then clears any stale one). A suggestion needs a
 * main tag Jev is at least TAG_SUGGEST_MIN_P sure of, that no one
 * dismissed, and that would change the chat: the same main tag with no
 * confident sub-tag, or with the sub-tag the chat already has, is not one.
 */
export function suggestionFor(
  tag: TagSuggestion,
  chat: ChatTagState
): StoredSuggestion | null {
  if (!tag.mainId || !(tag.mainP >= TAG_SUGGEST_MIN_P)) return null;
  if (tag.mainId === chat.dismissedId) return null;
  const subId =
    tag.subId && isNum(tag.subP) && tag.subP >= TAG_SUGGEST_MIN_P
      ? tag.subId
      : null;
  if (
    tag.mainId === chat.chatTagId &&
    (subId === null || subId === chat.chatSubTagId)
  )
    return null;
  return { mainId: tag.mainId, subId, p: tag.mainP };
}

async function readTriageSignals(
  db: SupabaseClient,
  accountId: string,
  messageId: string,
  hashKey: string | undefined,
  model: string
): Promise<InsightsSignals | null> {
  const { data, error } = await db
    .from('ts_decision_log')
    .select('answers, model_id')
    .eq('account_id', accountId)
    .eq('check_name', 'triage')
    .eq('message_id', messageHash(messageId, hashKey))
    .order('created_at', { ascending: false })
    .limit(3);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as {
    answers: unknown;
    model_id: string | null;
  }[]) {
    // The bands assume the pinned model's scales.
    if (row.model_id !== model) continue;
    const s = signalsFromTriageAnswers(row.answers);
    if (s) return s;
  }
  return null;
}

async function readChatTags(
  db: SupabaseClient,
  accountId: string,
  conversationId: string
): Promise<ChatTagState | null> {
  const { data, error } = await db
    .from('conversations')
    .select('chat_tag_id, chat_sub_tag_id, tag_suggestion_dismissed_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as {
    chat_tag_id: string | null;
    chat_sub_tag_id: string | null;
    tag_suggestion_dismissed_id: string | null;
  };
  return {
    chatTagId: row.chat_tag_id,
    chatSubTagId: row.chat_sub_tag_id,
    dismissedId: row.tag_suggestion_dismissed_id,
  };
}

/** Judge one inbound customer message and store what Jev said. Never throws. */
export async function runInboundInsights(
  args: InboundInsightsArgs
): Promise<InboundInsightsOutcome> {
  const { accountId, conversationId, messageId, text, messageAt } = args;
  const out: InboundInsightsOutcome = {
    skipped: null,
    settings: null,
    reusedTriage: false,
    signals: null,
    deep: null,
    judgment: null,
    tag: null,
    chat: null,
    basisAt: null,
    signalsWritten: false,
    history: null,
    attention: null,
    suggestion: 'untouched',
    stored: null,
  };
  if (!text.trim()) return { ...out, skipped: 'blank' };
  try {
    if (!insightsAvailable(accountId))
      return { ...out, skipped: 'unavailable' };
    const ts = getDecisionLayer();
    if (!ts) return { ...out, skipped: 'unavailable' };
    const settings = await getInsightSettings(accountId);
    out.settings = settings;
    const signalsOn = settings.signalsEnabled;
    const tagsOn = settings.tagSuggestMode !== 'off';
    if (!signalsOn && !tagsOn) return { ...out, skipped: 'off' };
    if (
      !checkRateLimit(`insights:${accountId}`, RATE_LIMITS.insightsAccount)
        .success
    )
      return { ...out, skipped: 'rate_limited' };

    const db = supabaseAdmin();
    // Taken before the read: a change landing after this instant (a
    // person's tag, a dismissal, another judgment) stamps a later basis
    // and so wins over this run's writes.
    const readAt = new Date().toISOString();
    const [triage, catalogue, chat] = await Promise.all([
      signalsOn
        ? readTriageSignals(
            db,
            accountId,
            messageId,
            ts.config.logHashKey,
            ts.config.model
          )
        : null,
      tagsOn ? loadTagCatalogue(db, accountId) : null,
      tagsOn ? readChatTags(db, accountId, conversationId) : null,
    ]);
    out.chat = chat;
    out.basisAt = chat ? readAt : null;
    out.reusedTriage = triage !== null;
    const askSignals = signalsOn && triage === null;
    // A chat that vanished meanwhile gets no tag question.
    const tags =
      catalogue && chat && catalogue.mains.length > 0 ? catalogue : null;

    let signals = triage;
    let deep: InsightsDeep | null = null;
    // Customer insights always ask the deep figures, so with them on there
    // is one request per message even when triage supplied the signals.
    if (signalsOn || tags) {
      const context = await buildConversationContext(db, conversationId);
      const judgment = await ts.insights({
        accountId,
        message: text,
        recentTurns: turnsBefore(context, text)
          .slice(-RECENT_TURNS)
          .map((m) => ({
            from: m.role === 'user' ? 'customer' : 'taamul',
            text: m.content,
          })),
        journeyStage: 'open_conversation',
        askSignals,
        askDeep: signalsOn,
        tags,
      });
      out.judgment = judgment;
      // A failed judgment stores nothing, triage figures included: the
      // badges keep what the last good judgment said.
      if (!judgment.ok) return out;
      if (askSignals) signals = judgment.signals;
      if (signalsOn) deep = judgment.deep ?? null;
      out.tag = judgment.tag;
    }
    out.signals = signals;
    out.deep = deep;

    const writes: Promise<void>[] = [];
    if (signalsOn && signals) {
      writes.push(
        writeSignals(
          db,
          accountId,
          conversationId,
          signals,
          deep,
          messageAt
        ).then(() => {
          out.signalsWritten = true;
        })
      );
      writes.push(
        recordHistory(
          db,
          accountId,
          conversationId,
          signals,
          deep,
          messageAt
        ).then((ok) => {
          out.history = ok ? 'stored' : 'failed';
        })
      );
      // The pin is decided per message, not forward-only: an urgent
      // message judged after a calmer newer one still asked for someone.
      // What stops a stale pin is the "a person already replied" check.
      const reason = attentionReason(
        {
          urgency: signals.urgency,
          upset: signals.upset,
          wantsHuman: signals.wantsHuman,
          leadTemp: signals.leadTemp,
          callback: deep?.callback,
        },
        attentionRulesFrom(settings)
      );
      if (reason) {
        writes.push(
          applyInsightAttention(db, {
            accountId,
            conversationId,
            contactId: args.contactId,
            messageAt,
            reason,
            notify: settings.attentionNotify,
          }).then((a) => {
            out.attention = a;
          })
        );
      }
    }
    if (tagsOn && chat && out.tag) {
      const next = suggestionFor(out.tag, chat);
      out.stored = next;
      writes.push(
        writeSuggestionIfCurrent(
          db,
          accountId,
          conversationId,
          next,
          chat,
          readAt
        ).then((written) => {
          out.suggestion = !written
            ? 'superseded'
            : next
              ? 'stored'
              : 'cleared';
        })
      );
    }
    await Promise.all(writes);
    return out;
  } catch (err) {
    console.error(
      '[insights] inbound judgment failed:',
      err instanceof Error ? err.message : String(err)
    );
    return { ...out, skipped: 'error' };
  }
}

async function writeSignals(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  s: InsightsSignals,
  deep: InsightsDeep | null,
  messageAt: string
): Promise<void> {
  const { error } = await db
    .from('conversations')
    .update({
      ...(deep ? deepColumns(deep) : {}),
      insight_intent: s.intent.key,
      insight_intent_p: s.intent.p,
      insight_urgency: s.urgency,
      insight_lead_temp: s.leadTemp,
      insight_upset: s.upset,
      insight_wants_human: s.wantsHuman,
      insight_priority: priorityOf({
        urgency: s.urgency,
        upset: s.upset,
        wantsHuman: s.wantsHuman,
        leadTemp: s.leadTemp,
      }),
      insight_at: messageAt,
    })
    .eq('id', conversationId)
    .eq('account_id', accountId)
    // Forward only: an older message whose judgment finishes after a
    // newer one's must not put its figures back.
    .or(`insight_at.is.null,insight_at.lte.${messageAt}`);
  if (error) throw new Error(error.message);
}

const deepColumns = (d: InsightsDeep) => ({
  insight_sentiment: d.sentiment,
  insight_objections: objectionsFrom(d.objections),
  insight_needs_reply: d.needsReply,
  insight_callback: d.callback,
});

/**
 * One conversation_insight_events row for this judged message (numbers
 * and codes only, never text), then the chat trimmed to its newest
 * INSIGHT_HISTORY_KEEP rows. History is display data: a failure is
 * logged, returns false and changes nothing else.
 */
async function recordHistory(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  s: InsightsSignals,
  deep: InsightsDeep | null,
  messageAt: string
): Promise<boolean> {
  try {
    const { error } = await db.from('conversation_insight_events').insert({
      account_id: accountId,
      conversation_id: conversationId,
      message_at: messageAt,
      figures: {
        intent: s.intent.key,
        urgency: s.urgency,
        leadTemp: s.leadTemp,
        upset: s.upset,
        wantsHuman: s.wantsHuman,
        sentiment: deep?.sentiment ?? null,
        objections: deep ? objectionsFrom(deep.objections) : null,
        needsReply: deep?.needsReply ?? null,
        callback: deep?.callback ?? null,
        priority: priorityOf({
          urgency: s.urgency,
          upset: s.upset,
          wantsHuman: s.wantsHuman,
          leadTemp: s.leadTemp,
        }),
      },
    });
    if (error) throw new Error(error.message);

    // The rows past the newest KEEP (by message time), at most a batch:
    // normally just the one this insert pushed out.
    const { data: old, error: oldErr } = await db
      .from('conversation_insight_events')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('account_id', accountId)
      .order('message_at', { ascending: false })
      .order('created_at', { ascending: false })
      .range(
        INSIGHT_HISTORY_KEEP,
        INSIGHT_HISTORY_KEEP + HISTORY_TRIM_BATCH - 1
      );
    if (oldErr) throw new Error(oldErr.message);
    const ids = ((old ?? []) as { id: string }[]).map((r) => r.id);
    if (ids.length > 0) {
      const { error: delErr } = await db
        .from('conversation_insight_events')
        .delete()
        .eq('conversation_id', conversationId)
        .eq('account_id', accountId)
        .in('id', ids);
      if (delErr) throw new Error(delErr.message);
    }
    return true;
  } catch (err) {
    console.error(
      `[insights] conversation ${conversationId}: history not saved:`,
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}

/**
 * Store (or, with `next` null, clear) the chat's tag suggestion, as a
 * compare-and-set on what the decision was made from. The decision reads
 * the chat's tags, then waits up to seconds for Jev; meanwhile a person
 * may tag the chat or dismiss the suggestion, or a newer message's
 * judgment may land. So the write requires the tags and the dismissal to
 * be still what was read, and `suggestion_basis_at` to be NULL or no later
 * than `basisAt`, the server time this decision read the chat (nothing
 * was decided since it looked); it then moves that column to `basisAt`.
 * Both sides are the app's clock at ms precision: the PUT chat-tags route
 * stamps now() when a person changes the tags, so a judgment that read
 * the chat before that change cannot store over it, even when the tags
 * read the same again (tagged, then untagged). Returns false when no row
 * matched: someone moved on, and nothing else is written.
 */
export async function writeSuggestionIfCurrent(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  next: StoredSuggestion | null,
  chat: ChatTagState,
  basisAt: string
): Promise<boolean> {
  let update = db
    .from('conversations')
    .update(
      next
        ? {
            suggested_chat_tag_id: next.mainId,
            suggested_chat_sub_tag_id: next.subId,
            suggested_tag_p: next.p,
            suggested_tag_at: new Date().toISOString(),
            suggestion_basis_at: basisAt,
          }
        : {
            suggested_chat_tag_id: null,
            suggested_chat_sub_tag_id: null,
            suggested_tag_p: null,
            suggested_tag_at: null,
            suggestion_basis_at: basisAt,
          }
    )
    .eq('id', conversationId)
    .eq('account_id', accountId);
  const same = (col: string, v: string | null) => {
    update = v === null ? update.is(col, null) : update.eq(col, v);
  };
  same('chat_tag_id', chat.chatTagId);
  same('chat_sub_tag_id', chat.chatSubTagId);
  same('tag_suggestion_dismissed_id', chat.dismissedId);
  const { data, error } = await update
    .or(`suggestion_basis_at.is.null,suggestion_basis_at.lte.${basisAt}`)
    .select('id');
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length > 0;
}
