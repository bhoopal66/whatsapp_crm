import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from './admin-client';
import { loadAiConfig } from './config';
import { buildConversationContext } from './context';
import { retrieveKnowledgeScored, type KnowledgeRetrieval } from './knowledge';
import { generateReply } from './generate';
import { buildSystemPrompt } from './defaults';
import { buildHandoffSummary, type AiHandoffReason } from './handoff';
import { matchEscalationKeyword } from './escalation';
import { logAiUsage } from './usage';
import { latestUserMessage } from './query';
import {
  runGuardrailGate,
  runPassageGate,
  runTriageGate,
  type TsRef,
} from './typesafe-gates';
import { markOptedOut } from './opt-out';
import { engineSendText } from '@/lib/flows/channel-send';
import {
  resolveAiReplyChannel,
  resolveChannelForSurface,
} from '@/lib/whatsapp/channels';
import type { WhatsAppProvider } from '@/lib/whatsapp/channels';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

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
  /** The gateway id of the inbound message, carried into the TypeSafe
   *  decision log (063) so a decision can be traced to its message. */
  inboundMessageId?: string | null;
  /** The inbound's text (a media caption included). The bot's context
   *  holds text rows only, so a caption reaches the gates through this. */
  inboundText?: string | null;
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
    inboundMessageId = null,
    inboundText = null,
  } = args;
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

  try {
    const db = supabaseAdmin();

    const config = await loadAiConfig(db, accountId);
    if (!config || !config.autoReplyEnabled) return 'skipped';

    // Only answer on the bot's own number. Resolved here, before any
    // LLM spend, with the same lookup `engineSendText` will make.
    //
    // With the exact inbound number known, ask the same question the
    // send will answer (`resolveAiReplyChannel` — pin, explicit route,
    // thread number) and require it to BE that number: replying from
    // anywhere else lands outside Meta's 24h window, or on a number the
    // admin meant to keep human.
    const botChannel = inboundChannelId
      ? await resolveAiReplyChannel(db, accountId, conversationId)
      : await resolveChannelForSurface(db, accountId, 'ai_reply');
    if (
      inboundChannelId
        ? botChannel.id !== inboundChannelId
        : botChannel.provider !== inboundProvider
    ) {
      return 'skipped';
    }

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. A button tap also fires
    // `interactive_reply`, so for a tap that trigger counts too — an
    // automation-built menu answers its own buttons. (Relationship
    // triggers like `first_inbound_message` don't count — they're not
    // per-message auto-responders.) Not when a Flow is asking: the run
    // consumed the message, so those automations never see it.
    if (!flowContext) {
      const autoResponderTriggers = ['new_message_received', 'keyword_match'];
      if (interactiveReply) autoResponderTriggers.push('interactive_reply');
      const { data: autoResponders } = await db
        .from('automations')
        .select('id')
        .eq('account_id', accountId)
        .eq('is_active', true)
        .in('trigger_type', autoResponderTriggers)
        .limit(1);
      if (autoResponders && autoResponders.length > 0) return 'skipped';
    }

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select(
        'assigned_agent_id, ai_autoreply_disabled, ai_reply_count, campaign_broadcast_id'
      )
      .eq('id', conversationId)
      .maybeSingle();
    if (convErr || !conv) return 'skipped';
    if (conv.assigned_agent_id) return 'skipped'; // a human owns this thread
    if (conv.ai_autoreply_disabled) return 'skipped'; // handed off / turned off here
    // Campaign replies only (migration 049): the thread must carry the
    // stamp `flagBroadcastReplyIfAny` writes when a customer answers a
    // broadcast. Everything else is left to the team.
    if (config.autoReplyCampaignOnly && !conv.campaign_broadcast_id) {
      return 'skipped';
    }

    const messages = await buildConversationContext(db, conversationId);
    if (messages.length === 0) return 'skipped';
    const question = latestUserMessage(messages);
    // What the gates judge: the message that triggered THIS dispatch.
    // Each inbound gets its own dispatch, so in a burst ("stop sending me
    // these" / "thanks") every message is judged once, as it arrives —
    // not the newest stored one, which a slower dispatch would otherwise
    // read for both. A media caption is not in the text-only context, so
    // it only reaches the gates this way. Callers that don't pass it (the
    // flow runner's fallback) keep the latest customer message.
    const customerTurn = inboundText?.trim() || question;

    /**
     * Stop auto-replying on this thread and hand it to a human: (a)
     * pause the bot here (sticky until re-enabled), (b) route the
     * conversation to the configured handoff agent — null leaves it in
     * the shared queue — and (c) leave a short internal note with the
     * reason so whoever picks it up has context. Assigning fires the
     * `on_conversation_assigned` trigger, which notifies the agent.
     *
     * `farewell` goes to the customer first so they aren't left with
     * silence — but only when a reply slot is free: the cap bounds
     * every bot message, farewell included.
     *
     */
    const handOff = async (
      reason: AiHandoffReason,
      detail: string | null,
      farewell: string | null
    ) => {
      if (farewell) {
        const { data: claimed } = await db.rpc('claim_ai_reply_slot', {
          conversation_id: conversationId,
          max_replies: config.autoReplyMaxPerConversation,
        });
        if (claimed === true) {
          await engineSendText({
            accountId,
            userId: configOwnerUserId,
            conversationId,
            contactId,
            text: farewell,
            aiGenerated: true,
            surface: 'ai_reply',
          });
        }
      }
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
        reason,
        detail,
      });
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
        ai_handoff_reason: reason,
      };
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId;
      }
      const { error: updErr } = await db
        .from('conversations')
        .update(update)
        .eq('id', conversationId);
      if (updErr) {
        // The customer may already have had the farewell; without this
        // line a held draft and its note would vanish without a trace.
        console.error('[ai auto-reply] handoff update failed:', {
          conversationId,
          reason,
          error: updErr.message,
        });
      }
    };

    // Reply cap (migration 054: a handoff, not silence). The bot has
    // said everything it may on this thread; a customer who is still
    // writing needs a person, so route the thread and leave the note
    // rather than let the message sit unanswered. Read here is a cheap
    // early-out — the authoritative check is the atomic claim below,
    // which can lose a race to a concurrent inbound; that one simply
    // sends nothing and the next message lands here.
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) {
      await handOff(
        'cap',
        `${conv.ai_reply_count} of ${config.autoReplyMaxPerConversation}`,
        config.handoffMessage
      );
      return 'handed_off';
    }

    // Gate 1 — escalation keywords. Deterministic and free: a refund /
    // complaint / legal message never reaches the model, whatever it
    // would have decided.
    const keyword = matchEscalationKeyword(
      customerTurn,
      config.escalationKeywords
    );
    if (keyword) {
      await handOff('keyword', keyword, config.handoffMessage);
      return 'handed_off';
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
      return 'skipped';
    }

    // TypeSafe triage (063): a request for a person, a complaint or an
    // opt-out goes to the team before any LLM spend. An opt-out gets no
    // farewell — they asked us to stop writing.
    const triage = await runTriageGate(tsRef, {
      messages,
      question,
      customerTurn,
      journeyStage: flowContext
        ? 'guided_flow'
        : conv.campaign_broadcast_id
          ? 'campaign_reply'
          : 'open_conversation',
    });
    if (triage.handoff) {
      // An acted-on opt-out stamps contacts.opted_out_at (migration
      // 076), which every broadcast skips when planned and when sent.
      const marked =
        triage.handoff.optOut === 'record' &&
        (await markOptedOut(db, { accountId, contactId }));
      await handOff(
        'triage',
        marked
          ? `${triage.handoff.detail}; marked opted-out`
          : triage.handoff.detail,
        triage.handoff.farewell ? config.handoffMessage : null
      );
      return 'handed_off';
    }

    // Ground the reply in the account's knowledge base (best-effort),
    // screened by the TypeSafe passage filter (063) when it acts.
    const passages = await runPassageGate(tsRef, {
      query: question,
      retrieval: await retrieveKnowledgeScored(db, accountId, config, question),
    });

    // Gate 2 — retrieval threshold. When the knowledge base has nothing
    // close enough, hand off rather than let the model improvise, and
    // record the question so the KB can be extended.
    const gap = retrievalGateFailure(
      passages.retrieval,
      config.retrievalMinScore,
      question
    );
    if (gap) {
      await logKnowledgeGap(db, {
        accountId,
        conversationId,
        question,
        bestScore: gap.bestScore,
      });
      await handOff('no_knowledge', gap.detail, config.handoffMessage);
      return 'handed_off';
    }

    const campaign = conv.campaign_broadcast_id
      ? await loadCampaignContext(db, accountId, conv.campaign_broadcast_id)
      : null;

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge: passages.knowledge,
      conflictingKnowledge: passages.conflicts,
      campaign,
      flow: flowContext ?? null,
      // A message that tried to steer the assistant is answered from the
      // knowledge base only (TypeSafe triage, 063).
      strictGrounding: config.strictGrounding || triage.restricted,
      notes: triage.promptNotes,
    });

    // Gate 3 — the model. A provider failure (bad key, rate limit,
    // timeout) is a handoff too: the alternative is a customer who
    // wrote in and never hears back, with nobody told.
    let generated: Awaited<ReturnType<typeof generateReply>>;
    try {
      generated = await generateReply({ config, systemPrompt, messages });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error('[ai auto-reply] provider call failed:', err);
      await handOff('error', detail, config.handoffMessage);
      return 'handed_off';
    }
    const { text, handoff, usage } = generated;

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    });

    // TypeSafe guardrail (063): any free text the model wrote is
    // screened before it can reach the customer — the reply, or the
    // closing line it put before a handoff marker. It checks the draft
    // against every source the prompt gave the model: the knowledge
    // excerpts, and the business's own text (instructions, the campaign
    // message, the flow step).
    const screened = text
      ? await runGuardrailGate(tsRef, {
          customerMessage: customerTurn,
          botReply: text,
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
        })
      : null;

    if (screened && screened.outcome !== 'send') {
      // Held or blocked — a reply, or the closing line before a handoff
      // marker: the draft goes to a person, never the customer, and the
      // configured handoff message stands in for it. A hand-off like any
      // other (paused, assigned, the note in the banner), including when
      // TypeSafe was unreachable: the operator's fail mode chose "hold".
      await handOff(
        'guardrail',
        handoff
          ? `${screened.detail} The model had also asked for a person.`
          : screened.detail,
        config.handoffMessage
      );
      return 'handed_off';
    }

    if (handoff || !text) {
      // The model can't (or shouldn't) answer. A closing line it put
      // before the marker ("a relationship manager will contact you")
      // still goes out first.
      await handOff('model', null, text || null);
      return 'handed_off';
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
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
      return 'skipped';
    }
    if (claimed !== true) return 'skipped'; // lost the per-conversation cap race

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
    return 'replied';
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err);
    return 'skipped';
  } finally {
    if (shadowWork.length) await Promise.allSettled(shadowWork);
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
