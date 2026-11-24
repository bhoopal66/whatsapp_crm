/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - WhatsApp sends — `channel-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Claim before sending: an UPDATE conditional on `current_node_key`
 *     and `last_advanced_at` parks the run (`current_node_key` null, "in
 *     transit") before the first send; the walk puts the pointer on the
 *     node it suspends on once that prompt is out. Of two quick messages
 *     one claims; the other, and any that arrives while the run is in
 *     transit, sends nothing. A run whose send fails is ended, never
 *     re-sent.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import { isActiveStaff } from '@/lib/auth/active-staff';
import { supabaseAdmin } from './admin-client';
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from './channel-send';
import { consentRefusal } from '@/lib/whatsapp/send-origin';
import { sendsMenusAsText } from '@/lib/whatsapp/channels';
import { decideFallback, resolveFallbackPolicy } from './fallback';
import {
  dispatchInboundToAiReply,
  notifyHandoff,
  type AiFlowContext,
} from '@/lib/ai/auto-reply';
import { salesAnswersOff } from '@/lib/ai/not-sales-chat';
import { dispatchChatTagSet } from '@/lib/automations/chat-tag-dispatch';
import { writeConversationChatTags } from '@/lib/chat-tags/server';
import type { ChatTagsPatch } from '@/types';
import { chatHasChatTag, planSetChatTag } from './chat-tags';
import {
  judgeMeanings,
  loadMeaningTurns,
  meaningCandidate,
} from '@/lib/insights/meaning';
import {
  resolveTypedReply,
  type TypedReplyResolution,
} from './typed-reply-judge';
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
} from './types';

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a Supabase / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string
): string | null {
  if (node.node_type === 'send_buttons') {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === 'send_list') {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? 'contains';
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (
      matchType === 'exact' ? haystack === needle : haystack.includes(needle)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The strings an inbound message offers to a flow's *entry* trigger.
 *
 * Typed text offers itself. A button / list tap offers two: the visible
 * title — what the customer would have typed had the button not been
 * there — and the stable reply_id, because the automation engine's
 * `interactive_reply` trigger routes on the id, so an author moving a
 * menu into a flow reaches for the same value.
 *
 * Matching the id does mean a keyword that happens to be a substring of
 * an id can fire (ids are author-controlled slugs, defaulting to
 * `btn_1`). That is the same substring semantic keyword triggers
 * already have for typed text, and the alternative — ignoring the id —
 * silently breaks the author who keyed on it.
 */
export function entryTriggerTexts(message: ParsedInbound): string[] {
  if (message.kind === 'text') return [message.text];
  return [...new Set([message.reply_title, message.reply_id])].filter(
    (v): v is string => Boolean(v && v.trim())
  );
}

/**
 * The vars a campaign-started run (migration 054) begins with, so the
 * flow can branch on the reply that started it without asking again:
 *
 *   campaign_reply    — the typed text, or the tapped button's title
 *   campaign_reply_id — the tapped button's id ("" for typed text)
 *
 *   campaign_reply_class   — Jev's class for the reply (interested,
 *                            question, not_now, not_interested,
 *                            wrong_person, stop, other), when campaign
 *                            reply sorting is on and answered in time
 *   campaign_reply_class_p — its probability, two decimals ("0.86")
 *
 * The class vars are absent, not empty, when no class came back, so a
 * `present` / `absent` condition tells "not judged" apart.
 *
 * A `condition` node on `var campaign_reply_id equals pos` routes a
 * template quick-reply straight into the POS branch; the false branch
 * (typed text, or a button the flow doesn't know) can send the menu.
 * `var campaign_reply_class equals interested` routes a typed "yes,
 * tell me more" the same way.
 */
export function campaignReplyVars(
  message: ParsedInbound,
  replyClass?: { cls: string; p: number } | null
): Record<string, string> {
  const base =
    message.kind === 'text'
      ? { campaign_reply: message.text, campaign_reply_id: '' }
      : {
          campaign_reply: message.reply_title,
          campaign_reply_id: message.reply_id,
        };
  if (!replyClass) return base;
  return {
    ...base,
    campaign_reply_class: replyClass.cls,
    campaign_reply_class_p: replyClass.p.toFixed(2),
  };
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === 'start' ||
    node_type === 'send_message' ||
    node_type === 'send_media' ||
    node_type === 'condition' ||
    node_type === 'set_tag'
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === 'send_buttons' ||
    node_type === 'send_list' ||
    node_type === 'collect_input'
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === 'handoff' || node_type === 'end';
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `chat_tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig['operator'];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / chat lacks the tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case 'present':
      return args.subjectValue !== undefined && args.subjectValue !== '';
    case 'absent':
      return args.subjectValue === undefined || args.subjectValue === '';
    case 'equals':
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? '');
    case 'contains':
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? '');
  }
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

type AdminClient = ReturnType<typeof supabaseAdmin>;

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one, and .maybeSingle() throws on >1 row — which would
  // kill dispatch for that contact's webhook entirely. .limit(1) is
  // forgiving: pick the newest, let the cron sweep clean up the
  // stale one.
  const { data, error } = await db
    .from('flow_runs')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .order('started_at', { ascending: false })
    .limit(1);
  if (error) {
    console.error('[flows] loadActiveRunForContact error:', error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function loadFlow(
  db: AdminClient,
  flowId: string
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from('flows')
    .select('*')
    .eq('id', flowId)
    .maybeSingle();
  if (error) {
    console.error('[flows] loadFlow error:', error.message);
    return null;
  }
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
async function loadAllNodes(
  db: AdminClient,
  flowId: string
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from('flow_nodes')
    .select('*')
    .eq('flow_id', flowId);
  if (error) {
    console.error('[flows] loadAllNodes error:', error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

/**
 * Whether a flow may message this contact: 'ok', 'refused' (opted out or
 * do-not-contact), or 'unknown' when the flags could not be read, which
 * sends nothing. A contact that is not there is the sender's to report.
 */
async function flowConsent(
  db: AdminClient,
  accountId: string,
  contactId: string
): Promise<'ok' | 'refused' | 'unknown'> {
  const { data, error } = await db
    .from('contacts')
    .select('opted_out_at, do_not_contact_at')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    console.error('[flows] opt-out read failed, not sending:', error.message);
    return 'unknown';
  }
  return consentRefusal(data) ? 'refused' : 'ok';
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | 'started'
    | 'node_entered'
    | 'message_sent'
    | 'reply_received'
    | 'fallback_fired'
    | 'handoff'
    | 'timeout'
    | 'error'
    | 'completed',
  node_key: string | null,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await db.from('flow_run_events').insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error('[flows] logEvent error:', error.message);
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string
): Promise<boolean> {
  // Fetch ALL run ids for this contact in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  const { data: runs } = await db
    .from('flow_runs')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId);
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count } = await db
    .from('flow_run_events')
    .select('id', { count: 'exact', head: true })
    .in('flow_run_id', runIds)
    .eq('event_type', 'reply_received')
    .filter('payload->>meta_message_id', 'eq', metaMessageId);
  return (count ?? 0) > 0;
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
  conversationId: string
): Promise<FlowRow | null> {
  // A tap used to be rejected outright here, on the reasoning that
  // interactive replies are responses to existing prompts. That holds
  // only while a prompt is outstanding — and this function runs solely
  // when the contact has NO active run, so there is nothing the tap
  // could be answering. What it actually blocked was issue #490: an
  // *automation* sends the buttons, the customer taps one, and the flow
  // whose keyword matches that button never starts. Retyping the label
  // by hand worked, which is the tell — same words, different envelope.
  const candidates = entryTriggerTexts(message);

  // Pull all active flows for this account. Active set is bounded
  // (the builder discourages double-trigger overlap; partial index
  // makes the lookup index-supported).
  const { data: flows, error } = await db
    .from('flows')
    .select('*')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .order('created_at', { ascending: true });
  if (error || !flows) return null;

  const typed = flows as FlowRow[];
  for (const flow of typed) {
    if (flow.trigger_type === 'keyword') {
      const cfg = flow.trigger_config as KeywordTriggerConfig;
      if (candidates.some((text) => matchesKeywordTrigger(text, cfg))) {
        return flow;
      }
    } else if (
      flow.trigger_type === 'first_inbound_message' &&
      isFirstInbound
    ) {
      // Also reachable by a tap now: a broadcast template with a
      // quick-reply button can genuinely be what prompts a contact's
      // first-ever inbound. The automations dispatcher has always
      // treated a tap that way (the webhook pushes
      // `first_inbound_message` regardless of envelope) — flows were
      // the inconsistent half.
      return flow;
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }

  // Meaning triggers come last: only when nothing above matched, and
  // only for typed text (a tap already says what it means, by id).
  if (message.kind !== 'text' || !message.text.trim()) return null;
  const intentFlows = typed.filter(
    (f) => f.trigger_type === 'intent' && f.entry_node_id
  );
  if (intentFlows.length === 0) return null;
  const matched = await judgeMeanings({
    accountId,
    messageKey: message.meta_message_id,
    text: message.text,
    recentTurns: () => loadMeaningTurns(conversationId, message.text),
    // An invalid stored config (an API PATCH can store an empty
    // description) is skipped, never sent to Jev.
    candidates: intentFlows.flatMap((f) => {
      const c = meaningCandidate(
        `flow:${f.id}`,
        f.trigger_config,
        f.updated_at
      );
      return c ? [c] : [];
    }),
  });
  return pickIntentFlow(intentFlows, matched);
}

/**
 * The intent flow to start: the highest p among those that cleared their
 * threshold (`matched`, keyed `flow:<id>`); a tie goes to the most
 * recently updated flow, then the larger id, so the choice never depends
 * on row order.
 */
export function pickIntentFlow(
  flows: FlowRow[],
  matched: Map<string, number>
): FlowRow | null {
  let best: FlowRow | null = null;
  let bestP = -1;
  for (const f of flows) {
    const p = matched.get(`flow:${f.id}`);
    if (p === undefined) continue;
    const newer =
      best !== null &&
      p === bestP &&
      (f.updated_at > best.updated_at ||
        (f.updated_at === best.updated_at && f.id > best.id));
    if (p > bestP || newer) {
      best = f;
      bestP = p;
    }
  }
  return best;
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

/**
 * A menu that could not be sent ends its run, as a failed `send_message`
 * does: an active run whose menu never went out would swallow the
 * customer's next messages. Returns false for the caller to pass on.
 */
async function failInteractiveSend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  err: unknown
): Promise<false> {
  await logEvent(db, run.id, 'error', node.node_key, {
    reason: 'send_interactive_failed',
    node_type: node.node_type,
    detail: err instanceof Error ? err.message : String(err),
  });
  await endRun(db, run.id, 'failed', 'send_interactive_failed');
  return false;
}

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow
): Promise<boolean> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  try {
    const { whatsapp_message_id } = await engineSendInteractiveButtons({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      bodyText: cfg.text,
      headerText: cfg.header_text,
      footerText: cfg.footer_text,
      buttons: cfg.buttons.map((b) => ({ id: b.reply_id, title: b.title })),
    });
    await logEvent(db, run.id, 'message_sent', node.node_key, {
      node_type: 'send_buttons',
      whatsapp_message_id,
    });
    // Look up our internal message id so we can stash it on the run.
    // Cheap — indexed on `messages.message_id`.
    const { data: msg } = await db
      .from('messages')
      .select('id')
      .eq('message_id', whatsapp_message_id)
      .maybeSingle();
    await db
      .from('flow_runs')
      .update({
        last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
      })
      .eq('id', run.id);
    return true;
  } catch (err) {
    return failInteractiveSend(db, run, node, err);
  }
}

async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow
): Promise<boolean> {
  const cfg = node.config as unknown as SendListNodeConfig;
  try {
    const { whatsapp_message_id } = await engineSendInteractiveList({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      bodyText: cfg.text,
      buttonLabel: cfg.button_label,
      headerText: cfg.header_text,
      footerText: cfg.footer_text,
      sections: cfg.sections.map((s) => ({
        title: s.title,
        rows: s.rows.map((r) => ({
          id: r.reply_id,
          title: r.title,
          description: r.description,
        })),
      })),
    });
    await logEvent(db, run.id, 'message_sent', node.node_key, {
      node_type: 'send_list',
      whatsapp_message_id,
    });
    const { data: msg } = await db
      .from('messages')
      .select('id')
      .eq('message_id', whatsapp_message_id)
      .maybeSingle();
    await db
      .from('flow_runs')
      .update({
        last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
      })
      .eq('id', run.id);
    return true;
  } catch (err) {
    return failInteractiveSend(db, run, node, err);
  }
}

/**
 * Give the run's chat to people: pending, and assigned to `assignTo` when
 * that person can take it and nobody holds the chat already. Returns who
 * it was assigned to, if anyone. Never throws; a write that failed is
 * logged and rings the admins, because the run ends either way and the
 * customer would otherwise wait for nobody.
 */
async function handOverChat(
  db: AdminClient,
  run: FlowRunRow,
  assignTo?: string
): Promise<string | null> {
  const conversationId = run.conversation_id;
  if (!conversationId) return null;
  const failed = async (what: string, detail: string) => {
    console.error(`[flows] hand-off ${what} failed:`, run.id, detail);
    await notifyHandoff(db, {
      accountId: run.account_id,
      conversationId,
      contactId: run.contact_id ?? '',
      recipientId: null,
      reasonClause: 'A flow handed this chat over but could not update it.',
    });
  };
  const now = new Date().toISOString();
  const { error } = await db
    .from('conversations')
    .update({ status: 'pending', updated_at: now })
    .eq('id', conversationId);
  if (error) await failed('status', error.message);
  if (!assignTo) return null;

  const person = await isActiveStaff(db, run.account_id, assignTo);
  if (person.error) {
    await failed('assignee check', person.error);
    return null;
  }
  if (!person.ok) {
    console.warn('[flows] hand-off assignee is not active staff:', run.id);
    return null;
  }
  const { data: taken, error: assignErr } = await db
    .from('conversations')
    .update({ assigned_agent_id: assignTo, updated_at: now })
    .eq('id', conversationId)
    .is('assigned_agent_id', null)
    .select('id');
  if (assignErr) {
    await failed('assignment', assignErr.message);
    return null;
  }
  return taken?.length ? assignTo : null;
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow
): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  const assignedTo = await handOverChat(db, run, cfg.assign_to);
  await logEvent(db, run.id, 'handoff', node.node_key, {
    note: cfg.note ?? null,
    assigned_to: assignedTo,
  });
  await endRun(db, run.id, 'handed_off', 'handoff_node');
}

/**
 * The chat tags of the run's conversation — the run's own when it
 * knows it, else the contact's most recently active chat (one per
 * contact). Null when there is no such chat.
 */
async function loadRunChatTags(
  db: AdminClient,
  run: FlowRunRow
): Promise<ChatTagsPatch | null> {
  if (!run.conversation_id && !run.contact_id) return null;
  let query = db
    .from('conversations')
    .select('chat_tag_id, chat_sub_tag_id')
    .eq('account_id', run.account_id);
  query = run.conversation_id
    ? query.eq('id', run.conversation_id)
    : query
        .eq('contact_id', run.contact_id as string)
        .is('personal_owner_id', null)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(1);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`chat tag lookup failed: ${error.message}`);
  if (!data) return null;
  const row = data as Partial<ChatTagsPatch>;
  return {
    chat_tag_id: row.chat_tag_id ?? null,
    chat_sub_tag_id: row.chat_sub_tag_id ?? null,
  };
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `chat_tag` → present iff the chat's main tag or sub-tag is
 *     `subject_key` (a chat tag UUID).
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 *
 * Any other subject — above all the retired contact-tag `"tag"` a
 * stored flow may still carry — evaluates false and logs, so the run
 * takes the false branch instead of failing.
 */
async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  cfg: ConditionNodeConfig
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === 'var') {
    const v = run.vars[cfg.subject_key];
    subjectValue =
      typeof v === 'string' ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === 'chat_tag') {
    const chat = await loadRunChatTags(db, run);
    subjectValue = chatHasChatTag(chat, cfg.subject_key)
      ? cfg.subject_key
      : undefined;
  } else if (cfg.subject === 'contact_field') {
    const ALLOWED = ['name', 'email', 'phone', 'company'] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    const { data } = await db
      .from('contacts')
      .select(cfg.subject_key)
      .eq('id', run.contact_id!)
      .maybeSingle();
    const raw = (data as Record<string, unknown> | null)?.[cfg.subject_key];
    subjectValue = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  } else {
    await logEvent(db, run.id, 'error', node.node_key, {
      reason: 'condition_subject_unsupported',
      subject: String(cfg.subject),
    });
    return false;
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

/**
 * Run a "Set chat tag" node: write the chat's tags with the engine's
 * service-role client, then fire `chat_tag_set` automations when that
 * changed something. Never throws and never stops the run — a failed
 * write is logged and the run follows its edge, as the contact-tag
 * node did. A contact-tag config, or one with no tag picked, writes
 * nothing.
 */
async function runSetChatTagNode(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow
): Promise<void> {
  const plan = planSetChatTag(node.config);
  if (plan.kind !== 'write') {
    await logEvent(db, run.id, 'error', node.node_key, {
      reason:
        plan.kind === 'legacy'
          ? 'set_tag_contact_tag_retired'
          : 'set_tag_unset',
    });
    return;
  }
  try {
    const result = await writeConversationChatTags(db, {
      accountId: run.account_id,
      ...(run.conversation_id
        ? { conversationId: run.conversation_id }
        : { contactId: run.contact_id ?? undefined }),
      next: plan.next,
    });
    if (!result.ok) {
      await logEvent(db, run.id, 'error', node.node_key, {
        reason: 'set_tag_failed',
        detail: result.message ?? result.reason,
      });
      return;
    }
    await dispatchChatTagSet({
      accountId: run.account_id,
      contactId: result.contactId,
      conversationId: result.conversationId,
      previous: result.previous,
      saved: result.saved,
    });
  } catch (err) {
    // Non-fatal — log + advance. A tag-write failure shouldn't strand
    // the customer mid-flow.
    await logEvent(db, run.id, 'error', node.node_key, {
      reason: 'set_tag_failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
function interpolateVars(
  template: string,
  vars: Record<string, unknown>
): string {
  if (!template) return '';
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

async function endRun(
  db: AdminClient,
  runId: string,
  status: 'completed' | 'handed_off' | 'timed_out' | 'failed',
  reason: string
): Promise<void> {
  await db
    .from('flow_runs')
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    })
    .eq('id', runId)
    .eq('status', 'active');
}

/** How long a walk may hold a run in transit before it counts as dead. */
const IN_TRANSIT_MS = 2 * 60 * 1000;

/**
 * Take the run for one walk (see "Concurrency model"). True when this
 * call won it; `run` then mirrors the row. Throws when the database
 * could not answer, so nothing is sent on a claim that may not be ours.
 */
async function claimRun(
  db: AdminClient,
  run: FlowRunRow,
  vars?: Record<string, unknown>
): Promise<boolean> {
  const patch = {
    current_node_key: null,
    last_advanced_at: new Date().toISOString(),
    reprompt_count: 0,
    ...(vars ? { vars } : {}),
  };
  const { data, error } = await db
    .from('flow_runs')
    .update(patch)
    .eq('id', run.id)
    .eq('status', 'active')
    .eq('current_node_key', run.current_node_key!)
    .eq('last_advanced_at', run.last_advanced_at)
    .select('id');
  if (error) throw new Error(`flow run claim failed: ${error.message}`);
  if (!data?.length) return false;
  Object.assign(run, patch);
  return true;
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>
): Promise<{
  outcome: 'advanced' | 'completed' | 'handed_off' | 'failed';
  /** The run's optimistic node update lost to a concurrent writer. */
  lostRace?: boolean;
}> {
  let currentKey: string | null = startNodeKey;
  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(db, run.id, 'error', null, {
        reason: 'next_node_key was null mid-advance',
      });
      await endRun(db, run.id, 'failed', 'missing_next_node');
      return { outcome: 'failed' };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, 'error', currentKey, {
        reason: 'node_not_found',
      });
      await endRun(db, run.id, 'failed', 'node_not_found');
      return { outcome: 'failed' };
    }
    await logEvent(db, run.id, 'node_entered', node.node_key, {
      node_type: node.node_type,
    });

    if (node.node_type === 'start') {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === 'send_message') {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars),
        });
        await logEvent(db, run.id, 'message_sent', node.node_key, {
          node_type: 'send_message',
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'send_text_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, 'failed', 'send_text_failed');
        return { outcome: 'failed' };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === 'send_media') {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars)
            : undefined,
          filename: cfg.filename,
        });
        await logEvent(db, run.id, 'message_sent', node.node_key, {
          node_type: 'send_media',
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'send_media_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, 'failed', 'send_media_failed');
        return { outcome: 'failed' };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === 'collect_input') {
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await logEvent(db, run.id, 'message_sent', node.node_key, {
          node_type: 'collect_input',
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from('messages')
          .select('id')
          .eq('message_id', whatsapp_message_id)
          .maybeSingle();
        await db
          .from('flow_runs')
          .update({
            last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
          })
          .eq('id', run.id);
      } catch (err) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'collect_input_prompt_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, 'failed', 'collect_input_prompt_failed');
        return { outcome: 'failed' };
      }
      const advanced = await advanceCurrentNodeKey(db, run, node.node_key);
      if (!advanced) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'lost_race_during_advance',
        });
      }
      return { outcome: 'advanced', lostRace: !advanced };
    }
    if (node.node_type === 'condition') {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: 'true' | 'false';
      try {
        branch = (await evaluateConditionNode(db, run, node, cfg))
          ? 'true'
          : 'false';
      } catch (err) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'condition_evaluation_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, 'failed', 'condition_evaluation_failed');
        return { outcome: 'failed' };
      }
      currentKey = branch === 'true' ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, 'node_entered', node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === 'set_tag') {
      const cfg = node.config as unknown as SetTagNodeConfig;
      await runSetChatTagNode(db, run, node);
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === 'send_buttons') {
      if (!(await sendButtonsAndSuspend(db, run, node))) {
        return { outcome: 'failed' };
      }
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(db, run, node.node_key);
      if (!advanced) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'lost_race_during_advance',
        });
      }
      return { outcome: 'advanced', lostRace: !advanced };
    }
    if (node.node_type === 'send_list') {
      if (!(await sendListAndSuspend(db, run, node))) {
        return { outcome: 'failed' };
      }
      const advanced = await advanceCurrentNodeKey(db, run, node.node_key);
      if (!advanced) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'lost_race_during_advance',
        });
      }
      return { outcome: 'advanced', lostRace: !advanced };
    }
    if (node.node_type === 'handoff') {
      await executeHandoff(db, run, node);
      return { outcome: 'handed_off' };
    }
    if (node.node_type === 'end') {
      await logEvent(db, run.id, 'completed', node.node_key);
      await endRun(db, run.id, 'completed', 'end_node');
      return { outcome: 'completed' };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, 'error', node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run.id, 'failed', 'unknown_node_type');
    return { outcome: 'failed' };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, 'error', currentKey, {
    reason: 'advance_loop_safety_break',
  });
  await endRun(db, run.id, 'failed', 'advance_loop_overflow');
  return { outcome: 'failed' };
}

/**
 * Put the run on the node whose prompt was just sent. Conditional on it
 * still being this walk's: active, in transit, and carrying the claim's
 * timestamp (a run ended meanwhile stays ended).
 */
async function advanceCurrentNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  newKey: string
): Promise<boolean> {
  // PostgREST: `.eq` never matches a null; use `.is` instead.
  const { data, error } = await db
    .from('flow_runs')
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    })
    .eq('id', run.id)
    .eq('status', 'active')
    .is('current_node_key', null)
    .eq('last_advanced_at', run.last_advanced_at)
    .select('id');
  if (error) {
    console.error('[flows] advanceCurrentNodeKey error:', error.message);
    // The prompt is out but the run could not be put on it. Left in
    // transit it would swallow the answer, so it ends instead.
    await endRun(db, run.id, 'failed', 'advance_write_failed');
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean }
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  try {
    const activeRun = await loadActiveRunForContact(
      db,
      input.accountId,
      input.contactId
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: 'duplicate_inbound_ignored',
        };
      }
      // Switched off (draft or archived) since the run started: the run
      // stops here and the message is dispatched as if there were none.
      // A flow that could not be read is not a flow switched off.
      const runFlow = await loadFlow(db, activeRun.flow_id);
      if (!runFlow || runFlow.status === 'active') {
        // An HR candidate's message is not an answer to a sales menu. The
        // run is left as it is: it may be waiting in a sales chat.
        if (await salesAnswersOff(input.salesChat)) {
          return {
            consumed: false,
            flow_run_id: activeRun.id,
            outcome: 'no_match',
          };
        }
        // One SELECT for the whole flow's nodes — advance loop is now
        // in-memory. See loadAllNodes.
        const consent = await flowConsent(db, input.accountId, input.contactId);
        if (consent !== 'ok') {
          if (consent === 'refused') {
            await endRun(db, activeRun.id, 'failed', 'customer_opted_out');
          }
          return {
            consumed: false,
            flow_run_id: activeRun.id,
            outcome: 'no_match',
          };
        }
        const nodes = await loadAllNodes(db, activeRun.flow_id);
        return await handleReplyForActiveRun(db, activeRun, input, nodes);
      }
      await endRun(db, activeRun.id, 'failed', 'flow_switched_off');
    }

    // No active run. A first reply to a campaign that names a follow-up
    // flow (migration 054) starts that flow ahead of the entry-trigger
    // scan — the campaign is the door the customer came through, so its
    // flow wins over whatever keyword their reply happens to contain.
    // Any trigger type qualifies, `manual` included: that is how a flow
    // is reserved for campaigns alone.
    if (input.campaign) {
      const campaignFlow = await loadFlow(db, input.campaign.followUpFlowId);
      if (
        campaignFlow &&
        campaignFlow.account_id === input.accountId &&
        campaignFlow.status === 'active' &&
        campaignFlow.entry_node_id
      ) {
        if (await salesAnswersOff(input.salesChat)) {
          return { consumed: false, outcome: 'no_match' };
        }
        const nodes = await loadAllNodes(db, campaignFlow.id);
        return startNewRun(db, campaignFlow, input, nodes, {
          broadcastId: input.campaign.broadcastId,
          vars: campaignReplyVars(
            input.message,
            input.campaign.replyClass ?? null
          ),
        });
      }
      // Archived / draft / deleted flow: fall through to the ordinary
      // triggers rather than drop the reply on the floor.
    }

    // Look for a flow whose entry trigger matches.
    const flow = await findEntryFlow(
      db,
      input.accountId,
      input.message,
      input.isFirstInboundMessage,
      input.conversationId
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: 'no_match' };
    }
    if (await salesAnswersOff(input.salesChat)) {
      return { consumed: false, outcome: 'no_match' };
    }
    const nodes = await loadAllNodes(db, flow.id);
    return startNewRun(db, flow, input, nodes);
  } catch (err) {
    console.error(
      '[flows] dispatchInboundToFlows threw:',
      err instanceof Error ? err.message : err
    );
    return { consumed: false, outcome: 'no_match' };
  }
}

/**
 * What the AI agent needs to know about the step a run is suspended on
 * (`ai` fallback, migration 054): the prompt the customer saw and the
 * options they were offered. `null` for `collect_input` — that node
 * accepts any text, so a fallback there means an empty message, which
 * is nothing for the agent to answer.
 */
export function flowContextForNode(
  node: { node_type: string; config: Record<string, unknown> },
  vars: Record<string, unknown>,
  flowName: string | undefined
): AiFlowContext | null {
  if (node.node_type === 'send_buttons') {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    return {
      flowName: flowName ?? '',
      promptText: interpolateVars(cfg.text ?? '', vars),
      promptTemplate: cfg.text ?? '',
      options: (cfg.buttons ?? []).map((b) => b.title),
    };
  }
  if (node.node_type === 'send_list') {
    const cfg = node.config as unknown as SendListNodeConfig;
    return {
      flowName: flowName ?? '',
      promptText: interpolateVars(cfg.text ?? '', vars),
      promptTemplate: cfg.text ?? '',
      options: (cfg.sections ?? []).flatMap((s) =>
        (s.rows ?? []).map((r) => r.title)
      ),
    };
  }
  return null;
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>
): Promise<DispatchInboundResult> {
  const { message } = input;
  // A run belongs to the chat it runs in: what the customer writes to
  // another of our numbers is not an answer to this one's menu, unless
  // it is a tap on that very menu.
  if (run.conversation_id && run.conversation_id !== input.conversationId) {
    const node = run.current_node_key ? nodes.get(run.current_node_key) : null;
    if (
      !node ||
      message.kind !== 'interactive_reply' ||
      !matchReplyId(node, message.reply_id)
    ) {
      return { consumed: false, flow_run_id: run.id, outcome: 'no_match' };
    }
  }
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  await logEvent(db, run.id, 'reply_received', run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === 'interactive_reply' ? message.reply_id : null,
    text_length: message.kind === 'text' ? message.text.length : null,
  });

  if (!run.current_node_key) {
    // Another message's walk is still sending: that walk speaks for the
    // run, and this message must not make it speak twice.
    if (Date.now() - Date.parse(run.last_advanced_at) < IN_TRANSIT_MS) {
      return {
        consumed: true,
        flow_run_id: run.id,
        outcome: 'duplicate_inbound_ignored',
      };
    }
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(db, run.id, 'failed', 'active_run_missing_current_node');
    return { consumed: false, flow_run_id: run.id, outcome: 'failed' };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    // The author deleted or renamed the node the run was waiting on.
    // The run is over; the customer's message still deserves an answer,
    // so it is handed back to the webhook (AI agent / automations).
    await endRun(db, run.id, 'failed', 'current_node_not_found');
    return { consumed: false, flow_run_id: run.id, outcome: 'failed' };
  }

  if (!isSuspending(currentNode.node_type)) {
    // The run never asked anything here, so nothing this message says
    // can move it: hand the message back rather than swallow it.
    await endRun(db, run.id, 'failed', 'current_node_not_waiting');
    return { consumed: false, flow_run_id: run.id, outcome: 'failed' };
  }

  // Three ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. Typed text on such a node that names an option (typed-reply.ts).
  //   3. Text reply on a collect_input node — capture into vars.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  // A typed answer's match event is written only once the advance has
  // gone through: a concurrent tap that won the optimistic update must
  // not leave an event saying this text moved the run.
  let typedMatch: TypedReplyResolution | null = null;
  let capture: { key: string; value: string } | null = null;
  if (
    message.kind === 'interactive_reply' &&
    (currentNode.node_type === 'send_buttons' ||
      currentNode.node_type === 'send_list')
  ) {
    matched = matchReplyId(currentNode, message.reply_id);
  } else if (
    message.kind === 'text' &&
    (currentNode.node_type === 'send_buttons' ||
      currentNode.node_type === 'send_list')
  ) {
    // A typed answer instead of a tap ("2", the option's label, "yes
    // the second one"), behind the meaning-triggers switch. A match
    // advances exactly as the tap would; no match falls through to the
    // fallback policy as before.
    const typed = await resolveTypedReply({
      accountId: run.account_id,
      node: currentNode,
      prompt:
        flowContextForNode(currentNode, run.vars, undefined)?.promptText ?? '',
      text: message.text,
      // OpenWA prints the options as a numbered list, so "2" must work
      // with the Smart insights switch off.
      menuSentAsText: input.inboundProvider
        ? sendsMenusAsText(input.inboundProvider)
        : false,
    });
    if (typed) {
      matched = typed.option.next_node_key;
      typedMatch = typed;
    }
  } else if (
    message.kind === 'text' &&
    currentNode.node_type === 'collect_input'
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    if (captured.length > 0 && cfg.var_key) {
      // Stored by the claim itself, so a lost claim stores nothing.
      capture = { key: cfg.var_key, value: captured };
      matched = cfg.next_node_key;
    }
  }

  if (matched) {
    const won = await claimRun(
      db,
      run,
      capture ? { ...run.vars, [capture.key]: capture.value } : undefined
    );
    if (!won) {
      return {
        consumed: true,
        flow_run_id: run.id,
        outcome: 'duplicate_inbound_ignored',
      };
    }
    if (capture) {
      await logEvent(db, run.id, 'node_entered', currentNode.node_key, {
        captured_key: capture.key,
        captured_length: capture.value.length,
      });
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    if (typedMatch && outcome.outcome !== 'failed' && !outcome.lostRace) {
      await logEvent(db, run.id, 'node_entered', currentNode.node_key, {
        reply_id: typedMatch.option.reply_id,
        matched_by: typedMatch.by,
        ...(typedMatch.by === 'meaning' ? { p: typedMatch.p } : {}),
      });
    }
    return {
      consumed: outcome.outcome !== 'failed',
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy.
  const flow = await loadFlow(db, run.flow_id);
  const policy = resolveFallbackPolicy(flow?.fallback_policy);

  // `ai` (migration 054): the customer went off-script — a question, a
  // remark — and the AI agent answers it in the context of the step
  // the run is waiting on, steering them back to the options. The run
  // does not move and the reprompt counter is untouched, so they can
  // ask again; the bot's own per-conversation cap bounds the spend.
  // The agent declining (off, wrong number, human-owned thread,
  // throttled) degrades to the reprompt policy below; the agent handing
  // off ends the run the same way an exhausted reprompt does.
  let aiAvailable: boolean | undefined;
  if (policy.on_unknown_reply === 'ai') {
    const flowContext = flowContextForNode(currentNode, run.vars, flow?.name);
    if (flowContext && input.inboundProvider && run.conversation_id) {
      const aiOutcome = await dispatchInboundToAiReply({
        accountId: run.account_id,
        conversationId: run.conversation_id,
        contactId: run.contact_id!,
        configOwnerUserId: input.userId,
        inboundProvider: input.inboundProvider,
        inboundChannelId: input.inboundChannelId ?? null,
        // The decision is about the chat the message came in on.
        salesChat:
          run.conversation_id === input.conversationId ? input.salesChat : null,
        flowContext,
        // Traces the TypeSafe decisions for this off-script reply (063),
        // and names the message the gates judge.
        inboundMessageId: input.message.meta_message_id,
        inboundText:
          input.message.kind === 'text'
            ? input.message.text
            : input.message.reply_title,
        interactiveReply: input.message.kind === 'interactive_reply',
        interactiveReplyId:
          input.message.kind === 'interactive_reply'
            ? input.message.reply_id
            : null,
      });
      await logEvent(db, run.id, 'fallback_fired', run.current_node_key, {
        action: 'ai',
        ai_outcome: aiOutcome,
        reprompt_count: run.reprompt_count,
      });
      // Superseded: the dispatch of a newer message answers this one too,
      // so the options must not be re-sent on top of that reply.
      if (aiOutcome === 'replied' || aiOutcome === 'superseded') {
        return {
          consumed: true,
          flow_run_id: run.id,
          outcome: 'fallback_fired',
        };
      }
      if (aiOutcome === 'handed_off') {
        await handOverChat(db, run);
        await logEvent(db, run.id, 'handoff', run.current_node_key, {
          reason: 'ai_handoff',
        });
        await endRun(db, run.id, 'handed_off', 'ai_handoff');
        return { consumed: true, flow_run_id: run.id, outcome: 'handed_off' };
      }
    }
    aiAvailable = false;
  }

  const newReprompts = run.reprompt_count + 1;
  // Claimed like an advance: of two off-script messages sent together
  // one re-sends the prompt, and none does once another message moved
  // the run.
  const { data: counted, error: countErr } = await db
    .from('flow_runs')
    .update({ reprompt_count: newReprompts })
    .eq('id', run.id)
    .eq('status', 'active')
    .eq('current_node_key', run.current_node_key)
    .eq('last_advanced_at', run.last_advanced_at)
    .eq('reprompt_count', run.reprompt_count)
    .select('id');
  if (countErr) throw new Error(`reprompt claim failed: ${countErr.message}`);
  if (!counted?.length && policy.on_unknown_reply !== 'ignore') {
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: 'duplicate_inbound_ignored',
    };
  }

  const action = decideFallback({
    policy,
    reprompt_count: newReprompts,
    aiAvailable,
  });
  await logEvent(db, run.id, 'fallback_fired', run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === 'ignore') {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: 'no_match' };
  }
  if (action.type === 'reprompt') {
    // Re-send the same prompt. Same node, no current_node_key change.
    if (currentNode.node_type === 'send_buttons') {
      if (!(await sendButtonsAndSuspend(db, run, currentNode))) {
        return { consumed: false, flow_run_id: run.id, outcome: 'failed' };
      }
    } else if (currentNode.node_type === 'send_list') {
      if (!(await sendListAndSuspend(db, run, currentNode))) {
        return { consumed: false, flow_run_id: run.id, outcome: 'failed' };
      }
    } else if (currentNode.node_type === 'collect_input') {
      // Customer typed something we couldn't accept (empty after trim,
      // or var_key missing — rare). Re-send the prompt so they try again.
      const cfg = currentNode.config as unknown as CollectInputNodeConfig;
      try {
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      } catch (err) {
        await logEvent(db, run.id, 'error', currentNode.node_key, {
          reason: 'reprompt_send_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { consumed: true, flow_run_id: run.id, outcome: 'fallback_fired' };
  }
  if (action.type === 'handoff') {
    await handOverChat(db, run);
    await logEvent(db, run.id, 'handoff', run.current_node_key, {
      reason: 'fallback_exhausted',
    });
    await endRun(db, run.id, 'handed_off', 'fallback_exhausted');
    return { consumed: true, flow_run_id: run.id, outcome: 'handed_off' };
  }
  // action.type === 'end'
  await endRun(db, run.id, 'completed', 'fallback_exhausted_end');
  return { consumed: true, flow_run_id: run.id, outcome: 'completed' };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
  /** Campaign-started runs only (migration 054). */
  seed?: { broadcastId: string; vars: Record<string, string> }
): Promise<DispatchInboundResult> {
  if ((await flowConsent(db, input.accountId, input.contactId)) !== 'ok') {
    return { consumed: false, outcome: 'no_match' };
  }
  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
  const { data: inserted, error: insErr } = await db
    .from('flow_runs')
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_contact` is over (account_id,
      // contact_id) WHERE status='active', so two accounts sharing
      // a contact phone number each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: 'active',
      // In transit until the first prompt is out (see claimRun).
      current_node_key: null,
      ...(seed ? { broadcast_id: seed.broadcastId, vars: seed.vars } : {}),
    })
    .select('*')
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? '';
    if (msg.includes('23505') || msg.includes('duplicate key')) {
      return { consumed: true, outcome: 'duplicate_inbound_ignored' };
    }
    console.error('[flows] startNewRun insert error:', insErr.message);
    return { consumed: false, outcome: 'no_match' };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, 'started', flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: seed ? 'campaign' : flow.trigger_type,
    broadcast_id: seed?.broadcastId ?? null,
    meta_message_id: input.message.meta_message_id,
  });
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  const { error: incErr } = await db.rpc('increment_flow_execution_count', {
    p_flow_id: flow.id,
  });
  if (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error('[flows] execution_count rpc error:', incErr.message);
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  if (outcome.outcome === 'failed') {
    // The run is over before the customer heard anything. Not consumed,
    // so the webhook lets the AI agent / automations answer instead.
    return { consumed: false, flow_run_id: run.id, outcome: 'failed' };
  }
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === 'advanced' ? 'started' : outcome.outcome,
  };
}
