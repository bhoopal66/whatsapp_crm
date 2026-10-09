import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from './admin-client';
import { loadAiConfig } from './config';
import { buildConversationContext } from './context';
import { retrieveKnowledgeScored, type KnowledgeRetrieval } from './knowledge';
import { generateReply } from './generate';
import {
  aiBurstWaitMs,
  aiDispatchBudgetMs,
  aiRequestTimeoutMs,
  buildSystemPrompt,
} from './defaults';
import {
  buildHandoffSummary,
  describeHandoffReason,
  upperFirst,
  type AiHandoffReason,
} from './handoff';
import type { AiDispatchOutcome, AiReplyTier, AiRouteSource } from './outcomes';
import { matchEscalationKeyword } from './escalation';
import { logAiUsage } from './usage';
import { latestUserMessage } from './query';
import {
  guardrailFeedback,
  runGuardrailGate,
  runPassageGate,
  runTriageGate,
  turnsBefore,
  type PassageGateResult,
  type TsRef,
} from './typesafe-gates';
import { isGreetingOrThanks, resolveTierModel, routeMessage } from './router';
import { markOptedOut } from './opt-out';
import { engineSendText } from '@/lib/flows/channel-send';
import {
  resolveAiReplyChannel,
  resolveChannelForSurface,
} from '@/lib/whatsapp/channels';
import type { WhatsAppProvider } from '@/lib/whatsapp/channels';
import { AiError, type AiConfig, type ChatMessage } from './types';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { triggerMatches } from '@/lib/automations/engine';
import type { Automation } from '@/types';

/**
 * Name + body of the campaign a thread was stamped with (migration
 * 048), for the system prompt. The body is the template text with its
 * `{{n}}` placeholders left in — the per-recipient values aren't worth
 * a second lookup; the model only needs to know what was offered.
 * Best-effort: any failure returns `null` and the reply is generated
 * without campaign context rather than not at all.
 */
export async function loadCampaignContext(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string
): Promise<{ name: string; body: string | null } | null> {
  try {
    const { data: bc } = await db
      .from('broadcasts')
      .select('name, template_name, template_language')
      .eq('id', broadcastId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!bc) return null;
    const { data: tpl } = await db
      .from('message_templates')
      .select('body_text')
      .eq('account_id', accountId)
      .eq('name', bc.template_name)
      .eq('language', bc.template_language)
      .limit(1)
      .maybeSingle();
    return { name: bc.name, body: tpl?.body_text ?? null };
  } catch (err) {
    console.error('[ai auto-reply] campaign context lookup failed:', err);
    return null;
  }
}

/**
 * Gate 2 — retrieval threshold (migration 052).
 *
 * Messages shorter than this many words skip the gate: "hi", "yes
 * please", "ok thanks" carry no question to ground, and handing every
 * greeting to a human would make the bot useless. The model still sees
 * them under the strict-grounding prompt, which forbids inventing facts.
 */
export const RETRIEVAL_GATE_MIN_WORDS = 4;

export interface RetrievalGateFailure {
  /** Human-readable clause for the handoff note. */
  detail: string;
  /** Best similarity seen, for the knowledge-gaps log (null = lexical). */
  bestScore: number | null;
}

/**
 * Decide whether retrieval was good enough to answer. Returns null when
 * the bot may proceed, or the failure to record when it must hand off.
 *
 * Pure, so the rule is testable without the dispatch harness:
 *   - gate off (`minScore` null) → proceed
 *   - no knowledge base at all → proceed (nothing to measure against;
 *     the strict-grounding prompt is the backstop)
 *   - short conversational turn → proceed
 *   - nothing retrieved → hand off
 *   - semantic best below the threshold → hand off
 *   - lexical-only hit (no score to compare) → proceed
 */
export function retrievalGateFailure(
  retrieval: KnowledgeRetrieval,
  minScore: number | null,
  question: string
): RetrievalGateFailure | null {
  if (minScore === null) return null;
  if (!retrieval.hasKnowledgeBase) return null;
  const words = question.trim().split(/\s+/).filter(Boolean).length;
  if (words < RETRIEVAL_GATE_MIN_WORDS) return null;

  if (retrieval.excerpts.length === 0) {
    return { detail: 'no matching excerpt', bestScore: null };
  }
  if (
    retrieval.bestSimilarity !== null &&
    retrieval.bestSimilarity < minScore
  ) {
    return {
      detail: `best similarity ${retrieval.bestSimilarity.toFixed(2)} < ${minScore.toFixed(2)}`,
      bestScore: retrieval.bestSimilarity,
    };
  }
  return null;
}

/**
 * The step a guided Flow is waiting on, handed over by the flow runner
 * when a customer types something off-script mid-flow
 * (`fallback_policy.on_unknown_reply: 'ai'`, migration 054). The bot
 * answers the message and steers the customer back to the options so
 * the run — which stays suspended on the same node — can continue.
 */
export interface AiFlowContext {
  flowName: string;
  /** The prompt text of the node the run is suspended on. */
  promptText: string;
  /**
   * The same text before `{{vars.…}}` interpolation — business-authored
   * only. The TypeSafe guardrail takes this as a trusted source, never
   * `promptText`: vars hold what the customer typed.
   */
  promptTemplate?: string;
  /** Visible titles of the buttons / list rows on that node. */
  options: string[];
}

export interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string;
  conversationId: string;
  contactId: string;
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string;
  /** Which number the inbound message arrived on. The bot only answers
   *  on the number the admin routed it to (see the provider gate). */
  inboundProvider: WhatsAppProvider;
  /**
   * The exact number the inbound arrived on (migration 060). With it the
   * gate compares numbers, not providers: an account can hold several
   * Whapi numbers, and "same provider" no longer means "same number".
   * Optional for older callers, which keep the provider comparison.
   */
  inboundChannelId?: string | null;
  /**
   * Present when the flow runner is asking on behalf of a suspended
   * run. The message-level automation gate is skipped in that case —
   * the run consumed the message, so no automation will answer it.
   */
  flowContext?: AiFlowContext | null;
  /**
   * True when the inbound was a button / list-row tap rather than typed
   * text. The tapped title is answered like any message, but an active
   * `interactive_reply` automation then counts as an auto-responder the
   * bot must stand down for (see the automation gate).
   */
  interactiveReply?: boolean;
  /**
   * The tapped button / list-row id. An `interactive_reply` automation
   * stands the bot down only when its `reply_ids` hold this id — the
   * same exact-id match the automation engine fires on.
   */
  interactiveReplyId?: string | null;
  /** The gateway id of the inbound message, carried into the TypeSafe
   *  decision log (063) so a decision can be traced to its message. */
  inboundMessageId?: string | null;
  /** The inbound's text (a media caption included). The bot's context
   *  holds text rows only, so a caption reaches the gates through this. */
  inboundText?: string | null;
  /** Clock for the dispatch budget (`aiDispatchBudgetMs`). Tests only. */
  now?: () => number;
}

/**
 * What the bot did with the inbound, for the caller that has to decide
 * what happens next (today: the flow runner's `ai` fallback).
 *
 *   replied    — a reply went out; the thread stays with the bot
 *   handed_off — a gate fired or the cap was reached; the thread is now
 *                a human's (`ai_autoreply_disabled` set)
 *   skipped    — the bot is not eligible here (off, wrong number,
 *                human-owned thread, nothing to answer, throttled) and
 *                sent nothing; the caller should answer some other way
 */
export type AiReplyOutcome = 'replied' | 'handed_off' | 'skipped';

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - there's nothing to reply to
 *   - the message arrived on a number other than the one the `ai_reply`
 *     surface is routed to (migration 046). A two-channel account can
 *     so run the bot on the Meta number alone and leave the Whapi
 *     number fully human — and a Meta-routed bot answering a Whapi
 *     inbound would in any case be refused: the customer never opened
 *     a service window on that number. Single-channel installs are
 *     unaffected (the route and the inbound are the same channel).
 *   - *Campaign replies only* (migration 049) is on and the thread was
 *     never stamped by a broadcast reply.
 *
 * The per-conversation reply cap is NOT a silent no-op: once reached
 * the thread is handed to a human with reason `cap` (migration 054),
 * because a customer still writing after the bot's last allowed reply
 * must reach someone.
 *
 * Then three gates, in order, each of which hands the thread to a human
 * with a recorded reason instead of calling the model (migration 052):
 *   1. an escalation keyword in the latest customer message;
 *   2. the knowledge base has nothing above the retrieval threshold;
 *   3. the model itself emits the handoff sentinel — or the provider
 *      call fails, which is treated the same way rather than leaving
 *      the customer unanswered in silence.
 *
 * The TypeSafe decision layer (063, `typesafe-gates.ts`) adds three
 * more, each a no-op unless its check is enabled, out of shadow and
 * under an approved policy: triage after gate 1 (may hand off, or
 * restrict the bot to the knowledge base), the passage filter between
 * retrieval and gate 2, and the guardrail between the model and the
 * send (may hold or block the draft).
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs
): Promise<AiReplyOutcome> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    inboundProvider,
    inboundChannelId,
    flowContext,
    interactiveReply = false,
    interactiveReplyId = null,
    inboundMessageId = null,
    inboundText = null,
    now = Date.now,
  } = args;
  // The dispatch runs inside an `after()` that the route's maxDuration
  // ends at 60 s. A generation is only started with room to finish and
  // hand off after it.
  const startedAt = now();
  const budgetMs = aiDispatchBudgetMs();
  /**
   * The provider timeout the next generation gets: the configured one,
   * cut to what is left of the budget less `GENERATION_RESERVE_MS` for
   * the send or hand-off after it. Null when that is under
   * `MIN_GENERATION_MS` (or a shorter configured timeout): the
   * generation is not started, because the runtime would kill it and
   * the customer would hear nothing, with nobody told.
   */
  const generationTimeoutMs = (): number | null => {
    const configured = aiRequestTimeoutMs();
    const left = budgetMs - (now() - startedAt) - GENERATION_RESERVE_MS;
    const timeoutMs = Math.min(configured, left);
    return timeoutMs >= Math.min(MIN_GENERATION_MS, configured)
      ? timeoutMs
      : null;
  };
  // TypeSafe checks in configured shadow cannot change the reply, so they
  // run off its path and are awaited in `finally` — still inside the
  // webhook's after(), never left floating.
  const shadowWork: Promise<unknown>[] = [];
  const tsRef: TsRef = {
    accountId,
    conversationId,
    contactId,
    messageId: inboundMessageId,
    defer: (work) => {
      shadowWork.push(work);
    },
  };

  // Set once the account's auto-reply is known to be on: from then on
  // every exit records why (migration 077), so "why didn't the bot
  // answer?" has an answer. An account with the bot off records nothing.
  let db: SupabaseClient | null = null;
  let recording = false;
  // Which tier this message was routed to and which model last generated
  // for it (null before any generation), for the `replied` and
  // `handed_off` records. Set once the router has answered.
  let routing: {
    tier: AiReplyTier;
    model: string | null;
    routeSource: AiRouteSource;
    escalated: boolean;
  } | null = null;
  const record = async (
    outcome: AiDispatchOutcome,
    detail: string | null = null
  ) => {
    if (recording && db) {
      const routed =
        outcome === 'replied' ||
        outcome === 'handed_off' ||
        outcome === 'held_for_review'
          ? routing
          : null;
      await recordOutcome(db, {
        accountId,
        conversationId,
        outcome,
        detail,
        ...routed,
      });
    }
  };
  const skip = async (
    outcome: AiDispatchOutcome,
    detail: string | null = null
  ): Promise<AiReplyOutcome> => {
    await record(outcome, detail);
    return 'skipped';
  };

  try {
    db = supabaseAdmin();
    const dbc = db;

    const config = await loadAiConfig(dbc, accountId);
    if (!config || !config.autoReplyEnabled) return 'skipped';
    recording = true;

    // Only answer on the bot's own number. Resolved here, before any
    // LLM spend, with the same lookup `engineSendText` will make.
    //
    // With the exact inbound number known, ask the same question the
    // send will answer (`resolveAiReplyChannel` — pin, explicit route,
    // thread number) and require it to BE that number: replying from
    // anywhere else lands outside Meta's 24h window, or on a number the
    // admin meant to keep human.
    const botChannel = inboundChannelId
      ? await resolveAiReplyChannel(dbc, accountId, conversationId)
      : await resolveChannelForSurface(dbc, accountId, 'ai_reply');
    if (
      inboundChannelId
        ? botChannel.id !== inboundChannelId
        : botChannel.provider !== inboundProvider
    ) {
      // Ids and providers only: the resolved channel carries credentials.
      return skip(
        'skipped_number',
        `The bot replies from ${botChannel.provider} number ${botChannel.id}; ` +
          `this message came in on ${inboundProvider}` +
          (inboundChannelId ? ` number ${inboundChannelId}` : '') +
          '.'
      );
    }

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so when one of them fires on THIS message we stand down
    // to avoid double-texting the customer. A button tap also fires
    // `interactive_reply`, so for a tap that trigger counts too — an
    // automation-built menu answers its own buttons. (Relationship
    // triggers like `first_inbound_message` don't count — they're not
    // per-message auto-responders.) Not when a Flow is asking: the run
    // consumed the message, so those automations never see it.
    //
    // Matched with the engine's own `triggerMatches`, on the context the
    // pipeline hands the engine. Standing down for any active one, as
    // this once did, silenced the bot on every message of an account
    // whose one keyword rule matched none of them.
    // `new_message_received` matches every message, so an active one
    // still stands the bot down: it is an auto-responder.
    if (!flowContext) {
      const autoResponderTriggers = ['new_message_received', 'keyword_match'];
      if (interactiveReply || interactiveReplyId) {
        autoResponderTriggers.push('interactive_reply');
      }
      const { data: autoResponders, error: autoErr } = await dbc
        .from('automations')
        .select('id, name, trigger_type, trigger_config')
        .eq('account_id', accountId)
        .eq('is_active', true)
        .in('trigger_type', autoResponderTriggers);
      if (autoErr) throw new Error(`automations lookup: ${autoErr.message}`);
      const matched = ((autoResponders ?? []) as Automation[]).find((a) =>
        triggerMatches(a, {
          message_text: inboundText ?? '',
          interactive_reply_id: interactiveReplyId ?? undefined,
        })
      );
      if (matched) {
        return skip(
          'skipped_automation',
          `Automation “${matched.name ?? matched.id}” answers this message.`
        );
      }
    }

    const { data: conv, error: convErr } = await dbc
      .from('conversations')
      .select(
        'assigned_agent_id, ai_autoreply_disabled, ai_reply_count, campaign_broadcast_id, ai_paused_reason, ai_paused_at'
      )
      .eq('id', conversationId)
      .maybeSingle();
    if (convErr) throw new Error(`conversation lookup: ${convErr.message}`);
    if (!conv) return skip('skipped_nothing', 'Conversation not found.');
    if (conv.assigned_agent_id) {
      return skip('skipped_assigned'); // a human owns this thread
    }
    if (conv.ai_autoreply_disabled) {
      // Handed off / turned off here — unless an agent's reply paused it
      // and they have since been quiet for the account's resume window.
      const resumed = await autoResumeIfDue(dbc, conversationId, conv, config);
      if (!resumed) {
        return skip(
          'skipped_paused',
          conv.ai_paused_reason ? `Paused: ${conv.ai_paused_reason}.` : null
        );
      }
    }
    // Campaign replies only (migration 049): the thread must carry the
    // stamp `flagBroadcastReplyIfAny` writes when a customer answers a
    // broadcast. Everything else is left to the team.
    if (config.autoReplyCampaignOnly && !conv.campaign_broadcast_id) {
      return skip('skipped_campaign_only');
    }

    // Bursts get one reply. A customer types "hi", then "I need a loan"
    // two seconds later; each inbound gets its own dispatch, and both
    // used to answer. Wait for them to finish, then only the dispatch
    // for the newest customer message carries on — and it answers the
    // whole burst (below). Before any TypeSafe or model spend. Not for
    // a Flow's fallback: the run is waiting on this exact message.
    // Only messages that get a dispatch of their own count: a photo with
    // no caption gets none, so it must not silence the text before it.
    const coalesce = !flowContext && Boolean(inboundMessageId);
    let newestAt: string | null = null;
    if (coalesce) {
      const waitMs = aiBurstWaitMs();
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      const newest = await newestCustomerMessage(dbc, conversationId);
      newestAt = newest?.at ?? null;
      if (newest?.id && newest.id !== inboundMessageId) {
        return skip(
          'skipped_superseded',
          'A newer customer message arrived; its reply answers both.'
        );
      }
    }

    // Read after the wait, so the burst is in it.
    const messages = await buildConversationContext(dbc, conversationId);
    if (messages.length === 0) return skip('skipped_nothing');
    // What the gates judge: the message that triggered THIS dispatch.
    // Coalesced, that is the burst it closes: every customer message
    // since our last one, so the reply addresses all of it. Otherwise
    // (the flow runner's fallback, callers with no message id) each
    // dispatch judges its own message — in a burst ("stop sending me
    // these" / "thanks") every message once, as it arrives, not the
    // newest stored one a slower dispatch would otherwise read for both.
    // A media caption is not in the text-only context, so it only
    // reaches the gates through `inboundText`. Callers that don't pass
    // it keep the latest customer message.
    const latest = latestUserMessage(messages);
    const customerTurn = coalesce
      ? burstTurn(messages, inboundText, newestAt) || latest
      : inboundText?.trim() || latest;
    const question = coalesce ? customerTurn : latest;
    // What the reply is FOR: every customer message since our last one,
    // however old — "Hi" after an unanswered "What are FAB's charges?"
    // still asks about FAB. The burst window above only bounds what this
    // dispatch judges (triage, keywords); retrieval, its gate and the
    // router read the open question, or a "Hi" retrieves nothing and the
    // model answers the earlier question blind.
    const openTurns = openCustomerTurns(messages, inboundText);
    const openText = openTurns.join('\n') || question;
    // When the open turns are only greetings, the question is an earlier
    // one even if we spoke since: "What are FAB's charges?", a hand-off
    // farewell, then "Hi" and a person clicking Resume & reply still asks
    // about FAB. Any such message also rules out the small tier and a
    // skipped retrieval below — those are for a true first "hi".
    const earlier = earlierCustomerQuestions(messages);
    const openQuestion =
      openTurns.length > 0 && openTurns.every(isGreetingOrThanks)
        ? [...earlier, ...openTurns].join('\n')
        : openText;

    /**
     * Why a write that requires the chat to still be the bot's found it
     * was not: re-read it. Null when it still looks like the bot's, or
     * can't be read.
     */
    const takenBy = async (): Promise<
      'skipped_assigned' | 'skipped_paused' | null
    > => {
      const { data, error } = await dbc
        .from('conversations')
        .select('assigned_agent_id, ai_autoreply_disabled')
        .eq('id', conversationId)
        .maybeSingle();
      if (error || !data) return null;
      const row = data as {
        assigned_agent_id: string | null;
        ai_autoreply_disabled: boolean | null;
      };
      if (row.assigned_agent_id) return 'skipped_assigned';
      if (row.ai_autoreply_disabled) return 'skipped_paused';
      return null;
    };

    /**
     * Stop auto-replying on this thread and hand it to a human: (a)
     * pause the bot here (sticky until re-enabled; reason `handoff`,
     * which auto-resume never lifts), (b) route the conversation to the
     * configured handoff agent — null leaves it in the shared queue —
     * (c) leave a short internal note with the reason so whoever picks
     * it up has context, and (d) ring the bell for whoever should pick
     * it up. Assigning fires the `on_conversation_assigned` trigger,
     * which already notifies the agent (`conversation_assigned`), so the
     * bell rings here only when the hand-off assigned nobody.
     *
     * `farewell` goes to the customer first so they aren't left with
     * silence — but only when a reply slot is free: the cap bounds
     * every bot message, farewell included. A farewell that fails to
     * send must not stop the hand-off: the customer would then be
     * unanswered AND nobody told.
     *
     * `reasonText` replaces the reason clause when the code only
     * approximates it (a failed WhatsApp send is recorded as `error`,
     * which would otherwise read "AI provider error").
     *
     * `outcome` is what gets recorded: `held_for_review` when the
     * guardrail's held draft waits on the chat for a person, `error`
     * when the reply itself failed to send.
     *
     * The update applies only while the chat is still the bot's
     * (unpaused, unassigned). When a person took it over since it was
     * read, nothing is overwritten, no bell rings, and the outcome is
     * recorded as their `skipped_assigned` / `skipped_paused`.
     */
    const handOff = async (
      reason: AiHandoffReason,
      detail: string | null,
      farewell: string | null,
      reasonText: string | null = null,
      outcome: 'handed_off' | 'held_for_review' | 'error' = 'handed_off'
    ): Promise<AiReplyOutcome> => {
      if (farewell) {
        const { data: claimed } = await dbc.rpc('claim_ai_reply_slot', {
          conversation_id: conversationId,
          max_replies: config.autoReplyMaxPerConversation,
        });
        if (claimed === true) {
          try {
            await engineSendText({
              accountId,
              userId: configOwnerUserId,
              conversationId,
              contactId,
              text: farewell,
              aiGenerated: true,
              surface: 'ai_reply',
            });
          } catch (err) {
            console.error('[ai auto-reply] handoff farewell failed:', {
              conversationId,
              reason,
              error: errorMessage(err),
            });
          }
        }
      }
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
        reason,
        detail,
        reasonText,
      });
      const now = new Date().toISOString();
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_paused_reason: 'handoff',
        ai_paused_at: now,
        ai_handoff_summary: summary,
        ai_handoff_reason: reason,
        // Pins the chat as Important (migration 078) until a person acts
        // on it — assigning the hand-off agent below is not acting.
        ai_attention_at: now,
      };
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId;
      }
      // Only while the chat is still the bot's: a person who took it over
      // since it was read (assigned it, or paused the bot) keeps it, with
      // their own reason and assignee.
      const { data: updated, error: updErr } = await dbc
        .from('conversations')
        .update(update)
        .eq('id', conversationId)
        .eq('ai_autoreply_disabled', false)
        .is('assigned_agent_id', null)
        .select('id');
      if (!updErr && (!Array.isArray(updated) || updated.length === 0)) {
        // Taken over meanwhile: they need no bell, and this dispatch
        // handed nothing off.
        const taken = (await takenBy()) ?? 'skipped_paused';
        console.warn(
          `[ai auto-reply] conversation ${conversationId} was taken over before the ${reason} hand-off; left as it is.`
        );
        await record(taken, detail ? `${reason}: ${detail}` : reason);
        return 'handed_off';
      }
      if (updErr) {
        // The customer may already have had the farewell; without this
        // line a held draft and its note would vanish without a trace.
        console.error('[ai auto-reply] handoff update failed:', {
          conversationId,
          reason,
          error: updErr.message,
        });
      }
      // One bell per hand-off: an assignment that landed has rung it.
      if (!update.assigned_agent_id || updErr) {
        await notifyHandoff(dbc, {
          accountId,
          conversationId,
          contactId,
          recipientId: conv.assigned_agent_id ?? null,
          reasonClause: upperFirst(
            reasonText?.trim() || describeHandoffReason(reason, detail)
          ),
        });
      }
      await record(outcome, detail ? `${reason}: ${detail}` : reason);
      return 'handed_off';
    };

    // Reply cap (migration 054: a handoff, not silence). The bot has
    // said everything it may on this thread; a customer who is still
    // writing needs a person, so route the thread and leave the note
    // rather than let the message sit unanswered. Read here is a cheap
    // early-out — the authoritative check is the atomic claim below,
    // which can lose a race to a concurrent inbound; that one simply
    // sends nothing and the next message lands here.
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) {
      return handOff(
        'cap',
        `${conv.ai_reply_count} of ${config.autoReplyMaxPerConversation}`,
        config.handoffMessage
      );
    }

    // Gate 1 — escalation keywords. Deterministic and free: a refund /
    // complaint / legal message never reaches the model, whatever it
    // would have decided.
    const keyword = matchEscalationKeyword(
      customerTurn,
      config.escalationKeywords
    );
    if (keyword) {
      return handOff('keyword', keyword, config.handoffMessage);
    }

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount
    );
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`
      );
      return skip(
        'skipped_rate_limited',
        'The account-wide auto-reply rate limit was reached.'
      );
    }

    // TypeSafe triage (063): a request for a person, a complaint or an
    // opt-out goes to the team before any LLM spend. An opt-out gets no
    // farewell — they asked us to stop writing.
    //
    // Alongside it, the model router picks the tier that answers this
    // message (small / standard / large; `router.ts`), judging the same
    // customer turn. Both are one TypeSafe request at most and neither
    // throws, so they run together; a triage hand-off still wins.
    const journeyStage = flowContext
      ? 'guided_flow'
      : conv.campaign_broadcast_id
        ? 'campaign_reply'
        : 'open_conversation';
    const [triage, routed] = await Promise.all([
      runTriageGate(tsRef, { messages, question, customerTurn, journeyStage }),
      routeMessage({
        config,
        accountId,
        message: openQuestion,
        recentTurns: turnsBefore(messages, openText)
          .slice(-ROUTE_TURNS)
          .map((m) => ({
            from: m.role === 'user' ? 'customer' : 'business',
            text: m.content,
          })),
        journeyStage,
        ctx: { inFlow: !!flowContext },
      }),
    ]);
    // The tier and model for this reply. A customer triage judged urgent
    // or ready to apply is worth more than the small model, and the
    // facts: such a turn is raised to the standard tier, with retrieval.
    // So is an open question that is not all greetings, or a greeting
    // with an earlier customer question anywhere in the context: the
    // small tier and a skipped retrieval are for a true first "hi" /
    // "thanks" alone, and Jev judges the newest turn, so the earlier
    // ones get the heuristic.
    const greetingsOnly =
      openTurns.slice(0, -1).every(isGreetingOrThanks) && earlier.length === 0;
    const route =
      routed.tier === 'small' &&
      (triage.urgent || triage.readyToApply || !greetingsOnly)
        ? {
            ...routed,
            ...resolveTierModel(config, 'standard'),
            skipKnowledge: false,
          }
        : routed;
    routing = {
      tier: route.tier,
      model: null,
      routeSource: route.source,
      escalated: false,
    };
    if (triage.handoff) {
      // An acted-on opt-out stamps contacts.opted_out_at (migration
      // 076), which every broadcast skips when planned and when sent.
      const marked =
        triage.handoff.optOut === 'record' &&
        (await markOptedOut(dbc, { accountId, contactId }));
      return handOff(
        'triage',
        marked
          ? `${triage.handoff.detail}; marked opted-out`
          : triage.handoff.detail,
        triage.handoff.farewell ? config.handoffMessage : null
      );
    }

    // Ground the reply in the account's knowledge base (best-effort),
    // screened by the TypeSafe passage filter (063) when it acts, for
    // the open question (above), not only the newest message. A
    // message the router judged to need no facts (a greeting, a thanks)
    // retrieves nothing — no embedding spend — and so has no excerpts
    // for the prompt or the guardrail, and no retrieval gate to clear,
    // unless it is escalated to a bigger model (below).
    const retrieve = async () =>
      runPassageGate(tsRef, {
        query: openQuestion,
        retrieval: await retrieveKnowledgeScored(
          dbc,
          accountId,
          config,
          openQuestion
        ),
      });
    // Gate 2 — retrieval threshold. When the knowledge base has nothing
    // close enough, hand off rather than let the model improvise, and
    // record the question so the KB can be extended.
    const gapIn = (p: PassageGateResult) =>
      retrievalGateFailure(p.retrieval, config.retrievalMinScore, openQuestion);
    const noKnowledge = async (gap: RetrievalGateFailure) => {
      await logKnowledgeGap(dbc, {
        accountId,
        conversationId,
        question: openQuestion,
        bestScore: gap.bestScore,
      });
      return handOff('no_knowledge', gap.detail, config.handoffMessage);
    };

    let skippedKnowledge = route.skipKnowledge;
    let passages: PassageGateResult = skippedKnowledge
      ? NO_PASSAGES
      : await retrieve();
    const gap = skippedKnowledge ? null : gapIn(passages);
    if (gap) return noKnowledge(gap);

    const campaign = conv.campaign_broadcast_id
      ? await loadCampaignContext(dbc, accountId, conv.campaign_broadcast_id)
      : null;

    const promptFor = (p: PassageGateResult) =>
      buildSystemPrompt({
        userPrompt: config.systemPrompt,
        mode: 'auto_reply',
        knowledge: p.knowledge,
        conflictingKnowledge: p.conflicts,
        campaign,
        flow: flowContext ?? null,
        // A message that tried to steer the assistant is answered from
        // the knowledge base only (TypeSafe triage, 063).
        strictGrounding: config.strictGrounding || triage.restricted,
        notes: triage.promptNotes,
      });
    let systemPrompt = promptFor(passages);

    /**
     * A turn that skipped knowledge, about to move onto a bigger model:
     * retrieve now and rebuild the prompt with the excerpts, so that
     * model is not answering blind. Returns the retrieval gate's
     * failure when the knowledge base has nothing close enough.
     */
    const groundForEscalation =
      async (): Promise<RetrievalGateFailure | null> => {
        if (!skippedKnowledge) return null;
        skippedKnowledge = false;
        passages = await retrieve();
        const failed = gapIn(passages);
        if (!failed) systemPrompt = promptFor(passages);
        return failed;
      };

    // Gate 3 — the model: the routed tier's. A provider failure (bad
    // key, rate limit, timeout) is a handoff too: the alternative is a
    // customer who wrote in and never hears back, with nobody told.
    //
    // Escalate on uncertainty, at most one extra generation per
    // dispatch, always on the account's own model (`config.model`):
    //   a. a tier model that differs from it failed, for a reason that
    //      is not the key or the rate limit (shared by every model on
    //      the key) — a retired or mistyped tier model, a timeout;
    //   b. the small tier asked for a person — a greeting the cheap
    //      model could not place is worth the account's model's look
    //      before a human is paged.
    // A turn that skipped knowledge is grounded before either.
    const generate = async (
      model: string,
      timeoutMs: number,
      prompt: string = systemPrompt
    ) => {
      routing = { ...routing!, model };
      const result = await generateReply({
        config,
        systemPrompt: prompt,
        messages,
        model,
        timeoutMs,
      });
      // Record token spend on the account's BYO key, per generation and
      // under the model that produced it. Fire-and-forget so it never
      // adds latency to the customer-facing send: `logAiUsage` swallows
      // its own errors, so the floating promise can't reject. Logged
      // regardless of handoff — the provider call happened either way.
      void logAiUsage(dbc, {
        accountId,
        conversationId,
        mode: 'auto_reply',
        provider: config.provider,
        model,
        usage: result.usage,
      });
      return result;
    };
    const escalate = (model: string, timeoutMs: number, prompt?: string) => {
      routing = { ...routing!, escalated: true };
      return generate(model, timeoutMs, prompt);
    };
    let generated: Awaited<ReturnType<typeof generateReply>> | null = null;
    let escalationGap: RetrievalGateFailure | null = null;
    /**
     * The escalation: ground the turn, then regenerate on the account's
     * model. False when the budget has no room for it (before or after
     * the retrieval); the caller then goes on as if it were not allowed.
     */
    const escalateOnAccountModel = async (): Promise<boolean> => {
      if (generationTimeoutMs() === null) return false;
      escalationGap = await groundForEscalation();
      if (escalationGap) return true;
      const timeoutMs = generationTimeoutMs();
      if (timeoutMs === null) return false;
      generated = await escalate(config.model, timeoutMs);
      return true;
    };
    const firstTimeoutMs = generationTimeoutMs();
    if (firstTimeoutMs === null) {
      return handOff('error', 'AI ran out of time', config.handoffMessage);
    }
    try {
      try {
        generated = await generate(route.model, firstTimeoutMs);
      } catch (err) {
        if (!retriesOnAccountModel(err, route.model, config.model)) throw err;
        console.warn(
          `[ai auto-reply] ${route.tier} model ${route.model} failed (${errorMessage(err)}); retrying on ${config.model}.`
        );
        if (!(await escalateOnAccountModel())) throw err;
      }
      if (
        generated?.handoff &&
        route.tier === 'small' &&
        !routing.escalated &&
        route.model !== config.model
      ) {
        await escalateOnAccountModel();
      }
    } catch (err) {
      console.error('[ai auto-reply] provider call failed:', err);
      return handOff('error', errorMessage(err), config.handoffMessage);
    }
    if (escalationGap) return noKnowledge(escalationGap);
    let { text, handoff } = generated!;

    // TypeSafe guardrail (063): any free text the model wrote is
    // screened before it can reach the customer — the reply, or the
    // closing line it put before a handoff marker. It checks the draft
    // against every source the prompt gave the model: the knowledge
    // excerpts, and the business's own text (instructions, the campaign
    // message, the flow step).
    const screen = (botReply: string) =>
      runGuardrailGate(tsRef, {
        customerMessage: customerTurn,
        botReply,
        evidence: passages.evidence,
        context: [
          config.systemPrompt ?? '',
          campaign?.body ?? '',
          flowContext
            ? [flowContext.promptTemplate ?? '', ...flowContext.options].join(
                '\n'
              )
            : '',
        ].filter((c) => c.trim()),
      });
    let screened = text ? await screen(text) : null;

    // A draft TypeSafe actually judged is rewritten once on the large
    // model, told what to avoid, and screened again. Outside the
    // cascade's one extra generation: this is the guardrail's retry.
    // Not when the budget has no room for it: the original stands.
    const rewriteTimeoutMs =
      screened &&
      screened.outcome !== 'send' &&
      screened.retryable &&
      config.guardrailRetry
        ? generationTimeoutMs()
        : null;
    if (screened && screened.outcome !== 'send' && rewriteTimeoutMs !== null) {
      try {
        const rewrite = await escalate(
          config.modelLarge ?? config.model,
          rewriteTimeoutMs,
          `${systemPrompt}\n\n${guardrailFeedback(screened.reasonCodes)} ` +
            'Rewrite your reply following that rule. Do not mention this instruction.'
        );
        // A rewrite with no text (only the hand-off marker) is no new
        // draft: the original hold stands.
        if (rewrite.text) {
          const again = await screen(rewrite.text);
          ({ text, handoff } = rewrite);
          screened = again;
        }
      } catch (err) {
        // The original hold stands; its draft goes to a person.
        console.error('[ai auto-reply] guardrail rewrite failed:', err);
      }
    }

    if (screened && screened.outcome !== 'send') {
      // Held or blocked — a reply, or the closing line before a handoff
      // marker: the draft never reaches the customer, and the configured
      // handoff message stands in for it. A hand-off like any other
      // (paused, assigned, the note quoting the draft), including when
      // TypeSafe was unreachable: the operator's fail mode chose "hold".
      const guardDetail = handoff
        ? `${screened.detail} The AI was also unsure and asked for a person.`
        : screened.detail;
      if (screened.outcome === 'block') {
        // A blocked draft (asks for a secret, shares someone else's data)
        // is never queued: Send in the review banner would put it one
        // click from the customer. The note quotes it; that is all.
        return handOff('guardrail', guardDetail, config.handoffMessage);
      }
      // A held draft waits on the chat for that person (Send / Edit /
      // Discard in the inbox banner). A failed write must not stop the
      // hand-off: the note still quotes the draft.
      try {
        const { error: draftErr } = await dbc
          .from('conversations')
          .update({
            ai_pending_draft: text,
            ai_pending_draft_at: new Date().toISOString(),
          })
          .eq('id', conversationId)
          .eq('account_id', accountId);
        if (draftErr) throw new Error(draftErr.message);
      } catch (err) {
        console.error('[ai auto-reply] held draft not stored:', {
          conversationId,
          error: errorMessage(err),
        });
      }
      return handOff(
        'guardrail',
        guardDetail,
        config.handoffMessage,
        null,
        'held_for_review'
      );
    }

    if (handoff || !text) {
      // The model can't (or shouldn't) answer. A closing line it put
      // before the marker ("a relationship manager will contact you")
      // still goes out first.
      return handOff('model', null, text || null);
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await dbc.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      }
    );
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr);
      return skip('error', `claim_ai_reply_slot failed: ${claimErr.message}`);
    }
    if (claimed !== true) {
      // The claim also refuses a chat a person paused or took meanwhile;
      // only when it did neither did the cap race take the last slot.
      return skip((await takenBy()) ?? 'skipped_cap_race');
    }

    try {
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text,
        aiGenerated: true,
        // Routed independently of the deterministic flow runner
        // (migration 046) — an admin can put the AI bot on one number and
        // flows on the other.
        surface: 'ai_reply',
      });
    } catch (err) {
      // The slot is spent and the customer heard nothing. This used to
      // land in the catch-all as a silent skip with a log line; now a
      // person is told. No farewell: it would go out on the number that
      // just failed.
      const detail = `WhatsApp send failed: ${errorMessage(err)}`;
      console.error('[ai auto-reply] reply send failed:', err);
      // Recorded once, as the error it is.
      return handOff(
        'error',
        detail,
        null,
        `${detail.slice(0, 200)}.`,
        'error'
      );
    }
    await record('replied');
    return 'replied';
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err);
    await record('error', errorMessage(err));
    return 'skipped';
  } finally {
    if (shadowWork.length) await Promise.allSettled(shadowWork);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Kept back from a generation's timeout for the send or hand-off. */
export const GENERATION_RESERVE_MS = 5_000;

/** A generation given less than this is not started. */
export const MIN_GENERATION_MS = 8_000;

/** Turns before the customer's message the router sees. */
const ROUTE_TURNS = 6;

/** What the prompt and the guardrail get when retrieval is skipped. */
const NO_PASSAGES: PassageGateResult = {
  knowledge: [],
  conflicts: [],
  evidence: [],
  retrieval: {
    excerpts: [],
    passages: [],
    bestSimilarity: null,
    hasKnowledgeBase: false,
  },
};

/**
 * Whether a failed generation on a routed tier's model is retried once
 * on the account's own model (escalation case a). Only a provider error
 * on a DIFFERENT model: a bad key or a rate limit holds for every model
 * on the key, and anything that is not an `AiError` is not the model's.
 */
export function retriesOnAccountModel(
  err: unknown,
  triedModel: string,
  accountModel: string
): boolean {
  return (
    err instanceof AiError &&
    triedModel !== accountModel &&
    err.code !== 'invalid_key' &&
    err.code !== 'rate_limited'
  );
}

/**
 * How far before the newest customer message a burst reaches. Without a
 * bound, "every customer message since our last one" also takes in an
 * old message nobody answered — one that sat through a silent hand-off,
 * say — and the gates judge it again: its escalation keyword hands the
 * thread off a second time, days later, on a customer's "thanks".
 */
export const BURST_JOIN_WINDOW_MS = 120_000;

/**
 * The customer turn a coalesced dispatch answers: every customer
 * message since the last message of ours that arrived within
 * `BURST_JOIN_WINDOW_MS` before the newest one (`newestAt`, else the
 * last in the context), oldest first, one per line — plus the
 * triggering message's text when the text-only context lacks it (a
 * media caption). Empty when the context ends on our message. A message
 * with no timestamp is kept.
 */
export function burstTurn(
  messages: ChatMessage[],
  inboundText: string | null,
  newestAt: string | null = null
): string {
  const run: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role !== 'user') break;
    run.unshift(messages[i]!);
  }
  const anchor = Date.parse(newestAt ?? run[run.length - 1]?.at ?? '');
  const tail = run
    .filter((m) => {
      const at = Date.parse(m.at ?? '');
      return (
        !Number.isFinite(anchor) ||
        !Number.isFinite(at) ||
        anchor - at <= BURST_JOIN_WINDOW_MS
      );
    })
    .map((m) => m.content.trim());
  const caption = inboundText?.trim();
  if (caption && !tail.includes(caption)) tail.push(caption);
  return tail.filter(Boolean).join('\n');
}

/** At most this many of the newest open customer turns are kept… */
export const OPEN_TURNS_MAX = 5;
/** …and at most this many characters of them (newest kept). */
export const OPEN_TURNS_MAX_CHARS = 1_000;

/**
 * The open customer turns: every customer message after our last one in
 * the context, oldest first — NOT bounded by `BURST_JOIN_WINDOW_MS`, so
 * a question that sat through a hand-off is still open when the customer
 * writes "Hi" later. Plus the triggering message's text when the
 * text-only context lacks it (a media caption). Capped to the newest
 * `OPEN_TURNS_MAX` turns and `OPEN_TURNS_MAX_CHARS` characters joined
 * (a newest turn longer than that alone is cut to fit). Empty when the
 * context ends on ours.
 */
export function openCustomerTurns(
  messages: ChatMessage[],
  inboundText: string | null = null
): string[] {
  const run: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role !== 'user') break;
    const text = messages[i]!.content.trim();
    if (text) run.unshift(text);
  }
  const caption = inboundText?.trim();
  if (caption && !run.includes(caption)) run.push(caption);
  const kept: string[] = [];
  let chars = 0;
  for (let i = run.length - 1; i >= 0 && kept.length < OPEN_TURNS_MAX; i--) {
    // A newline joins each kept turn to the next.
    const cost = run[i]!.length + (kept.length ? 1 : 0);
    if (chars + cost > OPEN_TURNS_MAX_CHARS) {
      if (kept.length === 0) kept.push(run[i]!.slice(0, OPEN_TURNS_MAX_CHARS));
      break;
    }
    kept.unshift(run[i]!);
    chars += cost;
  }
  return kept;
}

/** At most this many earlier customer questions extend a greeting. */
export const EARLIER_QUESTIONS_MAX = 2;

/**
 * The newest (up to `EARLIER_QUESTIONS_MAX`) customer messages BEFORE the
 * open turns that are not a greeting / thanks / acknowledgement, oldest
 * first — whatever we said after them (an answer, a hand-off farewell).
 * At most `OPEN_TURNS_MAX_CHARS` joined, newest kept (one longer than
 * that alone is cut to fit). Empty for a true first "hi".
 */
export function earlierCustomerQuestions(messages: ChatMessage[]): string[] {
  let i = messages.length - 1;
  // Skip the open run (the customer's messages since our last one).
  while (i >= 0 && messages[i]!.role === 'user') i--;
  const kept: string[] = [];
  let chars = 0;
  for (; i >= 0 && kept.length < EARLIER_QUESTIONS_MAX; i--) {
    const m = messages[i]!;
    const text = m.content.trim();
    if (m.role !== 'user' || !text || isGreetingOrThanks(text)) continue;
    const cost = text.length + 1;
    if (chars + cost > OPEN_TURNS_MAX_CHARS) {
      if (kept.length === 0) kept.push(text.slice(0, OPEN_TURNS_MAX_CHARS));
      break;
    }
    kept.unshift(text);
    chars += cost;
  }
  return kept;
}

/** How many recent captioned customer messages the burst check reads. */
const NEWEST_SCAN = 20;

/**
 * The gateway id (`messages.message_id`) and `created_at` of the
 * conversation's newest customer message that gets a dispatch of its
 * own: one with text (`content_text`, a media caption included), as the
 * inbound pipeline dispatches only a non-blank one. A caption-less photo
 * sent after a question must not supersede it, or nobody answers. Null
 * when it can't be read or none is found: the dispatch then answers
 * rather than risk nobody answering.
 */
async function newestCustomerMessage(
  db: SupabaseClient,
  conversationId: string
): Promise<{ id: string | null; at: string | null } | null> {
  const { data, error } = await db
    .from('messages')
    .select('message_id, created_at, content_text')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .not('content_text', 'is', null)
    .order('created_at', { ascending: false })
    .limit(NEWEST_SCAN);
  if (error) {
    console.error('[ai auto-reply] newest message lookup failed:', error);
    return null;
  }
  const row = (
    (data ?? []) as {
      message_id: string | null;
      created_at: string | null;
      content_text: string | null;
    }[]
  ).find((m) => m.content_text?.trim());
  return row ? { id: row.message_id, at: row.created_at } : null;
}

/**
 * Lift an `agent_reply` pause (migration 077) once the agents have been
 * quiet for `autoResumeMinutes`. True when this call lifted it.
 *
 * Never a `take_over` or `handoff` pause — a person chose those — and
 * never while someone is assigned. Compare-and-set on the `ai_paused_at`
 * that was read: an agent replying in the meantime refreshes it (the
 * 077 trigger), and then the chat stays paused.
 */
async function autoResumeIfDue(
  db: SupabaseClient,
  conversationId: string,
  conv: {
    assigned_agent_id: string | null;
    ai_paused_reason: string | null;
    ai_paused_at: string | null;
  },
  config: AiConfig
): Promise<boolean> {
  const minutes = config.autoResumeMinutes;
  if (!minutes || conv.ai_paused_reason !== 'agent_reply') return false;
  if (conv.assigned_agent_id || !conv.ai_paused_at) return false;
  const pausedAt = Date.parse(conv.ai_paused_at);
  if (!Number.isFinite(pausedAt)) return false;
  if (Date.now() - pausedAt < minutes * 60_000) return false;
  const { data, error } = await db
    .from('conversations')
    .update({
      ai_autoreply_disabled: false,
      ai_paused_reason: null,
      ai_paused_at: null,
    })
    .eq('id', conversationId)
    .eq('ai_paused_reason', 'agent_reply')
    .eq('ai_paused_at', conv.ai_paused_at)
    .is('assigned_agent_id', null)
    .select('id');
  if (error) {
    console.error('[ai auto-reply] auto-resume failed:', error);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * Ring the bell for a hand-off that assigned nobody (migration 077, type
 * `ai_handoff`): the chat's assignee, else every active owner and admin
 * — a hand-off nobody hears about leaves the customer as unanswered as
 * no hand-off. Best-effort: logged, never thrown, never blocks the
 * hand-off.
 */
export async function notifyHandoff(
  db: SupabaseClient,
  args: {
    accountId: string;
    conversationId: string;
    contactId: string;
    recipientId: string | null;
    reasonClause: string;
  }
): Promise<void> {
  try {
    let recipients: string[];
    if (args.recipientId) {
      recipients = [args.recipientId];
    } else {
      const { data, error } = await db
        .from('profiles')
        .select('user_id')
        .eq('account_id', args.accountId)
        .in('account_role', ['owner', 'admin'])
        .is('deactivated_at', null);
      if (error) throw new Error(error.message);
      recipients = ((data ?? []) as { user_id: string }[]).map(
        (p) => p.user_id
      );
    }
    if (recipients.length === 0) return;

    const { data: contact } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', args.contactId)
      .eq('account_id', args.accountId)
      .maybeSingle();
    const c = contact as { name: string | null; phone: string | null } | null;
    const who = c?.name?.trim() || c?.phone?.trim() || 'a customer';

    const { error } = await db.from('notifications').insert(
      recipients.map((userId) => ({
        account_id: args.accountId,
        user_id: userId,
        type: 'ai_handoff',
        // The bell opens the chat from conversation_id (/inbox?c=…).
        conversation_id: args.conversationId,
        contact_id: args.contactId,
        actor_user_id: null,
        title: `The AI agent handed over the chat with ${who}`,
        body: args.reasonClause,
      }))
    );
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error('[ai auto-reply] hand-off notification failed:', {
      conversationId: args.conversationId,
      error: errorMessage(err),
    });
  }
}

/**
 * Record what one dispatch did (migration 077): the conversation's
 * `ai_last_outcome` / `_detail` / `_at`, and an `ai_reply_events` row.
 * Best-effort and never throws — a lost record must not cost a reply.
 * `tier` / `model` / `routeSource` / `escalated` describe which model
 * answered, for the routed reply path.
 */
export async function recordOutcome(
  db: SupabaseClient,
  args: {
    accountId: string;
    conversationId: string;
    outcome: AiDispatchOutcome;
    detail?: string | null;
    tier?: AiReplyTier | null;
    model?: string | null;
    routeSource?: AiRouteSource | null;
    escalated?: boolean;
  }
): Promise<void> {
  const detail = args.detail ? args.detail.slice(0, 500) : null;
  try {
    const [convRes, eventRes] = await Promise.all([
      db
        .from('conversations')
        .update({
          ai_last_outcome: args.outcome,
          ai_last_outcome_detail: detail,
          ai_last_outcome_at: new Date().toISOString(),
        })
        .eq('id', args.conversationId)
        .eq('account_id', args.accountId),
      db.from('ai_reply_events').insert({
        account_id: args.accountId,
        conversation_id: args.conversationId,
        outcome: args.outcome,
        detail,
        tier: args.tier ?? null,
        model: args.model ?? null,
        route_source: args.routeSource ?? null,
        escalated: args.escalated ?? false,
      }),
    ]);
    if (convRes.error || eventRes.error) {
      console.error('[ai auto-reply] outcome not recorded:', {
        conversationId: args.conversationId,
        outcome: args.outcome,
        conversation: convRes.error?.message,
        event: eventRes.error?.message,
      });
    }
  } catch (err) {
    console.error('[ai auto-reply] outcome not recorded:', err);
  }
}

/**
 * Record a question the retrieval gate rejected (migration 052), for
 * the knowledge-base review under Settings → AI. Best-effort: a failed
 * insert is logged and never blocks the handoff.
 */
async function logKnowledgeGap(
  db: SupabaseClient,
  args: {
    accountId: string;
    conversationId: string;
    question: string;
    bestScore: number | null;
  }
): Promise<void> {
  try {
    const { error } = await db.from('ai_knowledge_gaps').insert({
      account_id: args.accountId,
      conversation_id: args.conversationId,
      question: args.question.slice(0, 2000),
      best_score: args.bestScore,
    });
    if (error)
      console.error('[ai auto-reply] knowledge gap insert failed:', error);
  } catch (err) {
    console.error('[ai auto-reply] knowledge gap insert failed:', err);
  }
}
