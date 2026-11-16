/**
 * Recruiter agents (package 026b): the service-role runner. Reads one HR
 * candidate chat through `hr_agent_context` (migration 202), runs the
 * pure orchestrator over the message to answer, and stores what it
 * decided as a DRAFT through `hr_agent_draft_create`. Nothing here sends
 * anything: a recruiter approves every draft.
 *
 * Server-only (service-role client, decrypted AI key). Never throws: an
 * unexpected error is logged once and answered `{ outcome: 'error' }`,
 * because the inbound hook runs it inside the webhook's after().
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAiConfig } from '@/lib/ai/config';
import { markOptedOut } from '@/lib/ai/opt-out';
import { logAiUsage } from '@/lib/ai/usage';
import type { AiConfig } from '@/lib/ai/types';
import { HR_STAGES, type HrStage } from '@/lib/hr/types';
import { detectLang } from './guardrails';
import { createAiModelPort } from './model';
import { run } from './orchestrator';
import type { ModelPort } from './ports';
import { systemClock } from './stub-model';
import {
  AGENT_KINDS,
  type AgentKind,
  type HandoffReason,
  type HistoryItem,
  type Intent,
} from './types';

export type HrAgentOutcome =
  | 'drafted'
  | 'handoff'
  | 'opted_out'
  | 'off'
  | 'no_ai'
  | 'no_message'
  | 'not_tracked'
  | 'not_recruiter'
  | 'closed'
  | 'contact_opted_out'
  | 'cap'
  | 'refused'
  | 'error';

export interface HrAgentRunResult {
  outcome: HrAgentOutcome;
  draftId?: string | null;
  /** The HINT of a refused `hr_agent_draft_create` (LIMIT, OPTED_OUT, …). */
  code?: string;
  intent?: Intent;
  handoff?: HandoffReason;
  flagged?: boolean;
}

/** History handed to the model: the last N messages up to the one answered. */
export const HR_AGENT_HISTORY_LIMIT = 10;

interface ContextRow {
  account_id: string;
  inbox: string;
  stage_key: string | null;
  closed: boolean;
  reply_state: string | null;
  last_inbound_at: string | null;
  contact_id: string | null;
  personal_owner_id: string | null;
  send_provider: 'whapi' | 'meta' | 'openwa' | null;
  opted_out: boolean;
  pending_drafts: number;
  drafts_today: number;
  enabled: Partial<Record<string, boolean>> | null;
}

interface MessageRow {
  id: string;
  sender_type: 'customer' | 'agent' | 'bot';
  content_text: string | null;
  created_at: string;
}

function asStage(v: string | null): HrStage | null {
  return v && (HR_STAGES as readonly string[]).includes(v)
    ? (v as HrStage)
    : null;
}

function enabledMap(
  raw: ContextRow['enabled']
): Partial<Record<AgentKind, boolean>> {
  const out: Partial<Record<AgentKind, boolean>> = {};
  for (const k of AGENT_KINDS) out[k] = raw?.[k] === true;
  return out;
}

function hintOf(err: unknown): string {
  const hint =
    err && typeof err === 'object' && 'hint' in err
      ? (err as { hint: unknown }).hint
      : null;
  return typeof hint === 'string' && hint ? hint : 'UNKNOWN';
}

/** The message to answer: the named one (a customer message of this chat) or the chat's latest customer message. */
async function loadSourceMessage(
  db: SupabaseClient,
  conversationId: string,
  sourceMessageId: string | null | undefined
): Promise<MessageRow | null> {
  const cols = 'id, sender_type, content_text, created_at';
  if (sourceMessageId) {
    const { data, error } = await db
      .from('messages')
      .select(cols)
      .eq('id', sourceMessageId)
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .maybeSingle();
    if (error) throw error;
    return (data as MessageRow | null) ?? null;
  }
  const { data, error } = await db
    .from('messages')
    .select(cols)
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as MessageRow[])[0] ?? null;
}

/** The chat's last messages up to and including `upTo`, text only, oldest first. */
async function loadHistory(
  db: SupabaseClient,
  conversationId: string,
  upTo: MessageRow
): Promise<HistoryItem[]> {
  const { data, error } = await db
    .from('messages')
    .select('id, sender_type, content_text, created_at')
    .eq('conversation_id', conversationId)
    .lte('created_at', upTo.created_at)
    .order('created_at', { ascending: false })
    .limit(HR_AGENT_HISTORY_LIMIT);
  if (error) throw error;
  return ((data ?? []) as MessageRow[])
    .slice()
    .reverse()
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      direction: m.sender_type === 'customer' ? 'in' : 'out',
      text: m.content_text!.trim(),
      at: m.created_at,
    }));
}

export async function runHrAgents(
  db: SupabaseClient,
  args: {
    accountId: string;
    conversationId: string;
    sourceMessageId?: string | null;
    actorUserId: string | null;
    slots?: string[];
    now?: Date;
    model?: ModelPort;
  }
): Promise<HrAgentRunResult> {
  const usageLogs: Promise<void>[] = [];
  try {
    const { data: ctxData, error: ctxError } = await db.rpc(
      'hr_agent_context',
      { p_conversation_id: args.conversationId }
    );
    if (ctxError) throw ctxError;
    const ctx = ((ctxData ?? []) as ContextRow[])[0];
    if (!ctx || ctx.account_id !== args.accountId) {
      return { outcome: 'not_tracked' };
    }
    if (ctx.inbox !== 'recruiter') return { outcome: 'not_recruiter' };
    if (ctx.closed) return { outcome: 'closed' };
    const enabled = enabledMap(ctx.enabled);
    if (!enabled.orchestrator) return { outcome: 'off' };
    if (ctx.opted_out) return { outcome: 'contact_opted_out' };

    const source = await loadSourceMessage(
      db,
      args.conversationId,
      args.sourceMessageId
    );
    const inboundText = source?.content_text?.trim() ?? '';
    if (!source || !inboundText) return { outcome: 'no_message' };
    const history = await loadHistory(db, args.conversationId, source);

    let config: AiConfig | null;
    try {
      config = await loadAiConfig(db, args.accountId);
    } catch (err) {
      console.error('[hr agents] AI config unreadable:', err);
      config = null;
    }
    if (!config) return { outcome: 'no_ai' };
    const aiConfig = config;

    const model =
      args.model ??
      createAiModelPort({
        config: aiConfig,
        onUsage: ({ model: usedModel, usage }) => {
          usageLogs.push(
            logAiUsage(db, {
              accountId: args.accountId,
              conversationId: args.conversationId,
              mode: 'hr_agent',
              provider: aiConfig.provider,
              model: usedModel,
              usage,
            })
          );
        },
      });
    const clock = args.now
      ? { now: () => new Date(args.now!.getTime()) }
      : systemClock;

    const result = await run(
      {
        accountId: args.accountId,
        conversationId: args.conversationId,
        stage: asStage(ctx.stage_key),
        replyState: ctx.reply_state ?? '',
        windowApplies: ctx.send_provider === 'meta',
        lastInboundAt: ctx.last_inbound_at,
        inboundText,
        history,
        settings: { enabled },
        slots: args.slots,
        pendingDrafts: ctx.pending_drafts ?? 0,
        draftsToday: ctx.drafts_today ?? 0,
        optedOut: ctx.opted_out,
      },
      { model, clock }
    );
    await Promise.all(usageLogs);

    const base = {
      intent: result.intent,
      ...(result.handoff ? { handoff: result.handoff } : {}),
    };

    if (result.optOut) {
      if (ctx.contact_id) {
        await markOptedOut(db, {
          accountId: args.accountId,
          contactId: ctx.contact_id,
        });
        const { error } = await db.rpc('hr_agent_supersede', {
          p_account_id: args.accountId,
          p_contact_id: ctx.contact_id,
        });
        if (error) console.error('[hr agents] supersede failed:', error);
      }
      return { ...base, outcome: 'opted_out' };
    }

    // An upset candidate is flagged whatever happens to the draft.
    let flagged = false;
    if (result.flag === 'urgent') {
      const { error } = await db.rpc('hr_agent_flag_urgent', {
        p_conversation_id: args.conversationId,
      });
      if (error) console.error('[hr agents] urgent flag failed:', error);
      else flagged = true;
    }
    const withFlag = flagged ? { flagged: true } : {};

    if (result.handoff === 'cap') {
      return { ...base, ...withFlag, outcome: 'cap' };
    }
    if (!result.draft && !result.handoff) {
      return { ...base, ...withFlag, outcome: 'handoff' };
    }

    const body = result.draft?.body ?? '';
    const { data: draftId, error: draftError } = await db.rpc(
      'hr_agent_draft_create',
      {
        p_conversation_id: args.conversationId,
        p_source_message_id: source.id,
        p_agent_kind: result.draft?.agentKind ?? result.agent,
        p_intent: result.intent,
        p_body: body,
        p_lang: result.draft?.lang ?? detectLang(inboundText),
        p_requires_template: result.draft?.requiresTemplate ?? false,
        p_handoff_reason: result.handoff ?? null,
        p_trace: result.trace,
        p_created_by: args.actorUserId,
      }
    );
    if (draftError) {
      return {
        ...base,
        ...withFlag,
        outcome: 'refused',
        code: hintOf(draftError),
      };
    }
    return {
      ...base,
      ...withFlag,
      outcome: body.trim() ? 'drafted' : 'handoff',
      draftId: (draftId as string | null) ?? null,
    };
  } catch (err) {
    console.error('[hr agents] run failed:', err);
    await Promise.allSettled(usageLogs);
    return { outcome: 'error' };
  }
}
