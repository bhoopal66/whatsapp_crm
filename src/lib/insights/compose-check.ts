// ============================================================
// Message check before sending (docs/jev-insights.md).
//
// Before an agent sends a free-text WhatsApp message, the composer asks
// for warnings about the draft. The answer only ever warns — nothing
// here blocks, edits or sends a message.
//
//   * Deterministic rules run whenever the feature is on: a bank the
//     account does not work with (the guardrail's bank dictionary) and a
//     claim to be a bank or regulated (regulator-claim.ts).
//   * Jev's figures (promise, terms, secrets, tone, and cold_pitch when
//     the draft would start a chat) are added when it answers within the
//     deadline. A Jev failure leaves the rules only.
//   * "Starts a chat" is team activity's rule (thread-guard.ts,
//     wouldStartChat): no message for 24 hours and the customer did not
//     write last. It matters only on a linked-device number (Whapi or
//     OpenWA), where WhatsApp restricts numbers for unsolicited bulk
//     messages; an unknown number is not a start, and neither is a
//     chat whose messages could not be read. A chat with no number yet
//     (opened from Contacts) is judged on the number its first send
//     would use (newChatProvider, the send path's own choice).
//
// When there is a warning, one compose_check_events row (migration 149,
// service role) records its codes — never the text — and its id goes
// back so the composer can report what the agent did next — unless the
// deadline has passed, when the composer has stopped waiting and sent,
// and a row would only sit "pending". Never throws.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import {
  composeCheckWarnings,
  detectBanksIn,
  getDecisionLayer,
  type PartnerCatalogue,
} from '@/lib/typesafe';
import { regulatorClaims } from '@/lib/typesafe/regulator-claim';
import { isLinkedDeviceNumber } from '@/lib/whatsapp/channel-management';
import { newChatProvider } from '@/lib/whatsapp/channels';
import { wouldStartChat } from '@/lib/team-activity/thread-guard';
import { getInsightSettings, insightsAvailable } from './settings';

/** migration 149's CHECK list, in the order warnings are shown. */
export const COMPOSE_WARNING_CODES = [
  'promise',
  'terms',
  'non_partner_bank',
  'regulator_claim',
  'secrets',
  'tone',
  'cold_pitch',
] as const;
export type ComposeWarningCode = (typeof COMPOSE_WARNING_CODES)[number];

export interface ComposeWarning {
  code: ComposeWarningCode;
  /** `rule`: a deterministic check; `jev`: a Jev judgment. */
  source: 'jev' | 'rule';
}

export interface ComposeCheckResult {
  warnings: ComposeWarning[];
  /** The compose_check_events row, or null (no warnings, or not stored). */
  eventId: string | null;
}

/** A draft shorter than this (trimmed) is not checked. */
export const COMPOSE_CHECK_MIN_CHARS = 12;
/** Whole-request budget the Jev call must finish inside. */
export const COMPOSE_CHECK_BUDGET_MS = 1800;
/** Below this much budget left, Jev is not asked at all. */
const MIN_JEV_MS = 250;
/** Messages read to decide "starts a chat"; the newest few are turns. */
const MESSAGES_READ = 20;
const RECENT_TURNS = 4;
/** Rule input is capped like the guardrail's state. */
const MAX_RULE_CHARS = 4000;

const NONE: ComposeCheckResult = { warnings: [], eventId: null };

interface MessageRow {
  sender_type: string;
  content_text: string | null;
  status: string | null;
  created_at: string;
}

export interface CheckDraftArgs {
  accountId: string;
  userId: string;
  conversationId: string;
  text: string;
  /** The caller's RLS client: the chat and its messages are read as them. */
  db: SupabaseClient;
  /** Epoch ms by which Jev must have answered. Default now + 1800 ms. */
  deadlineAt?: number;
  now?: () => number;
}

interface ChatContext {
  messages: MessageRow[];
  /** False when the messages read failed: then nothing is a start. */
  messagesRead: boolean;
  provider: string | null;
}

/** The chat's recent messages and its sending number's provider, read
 *  through the caller's RLS client. Unknown parts come back empty. */
async function loadContext(
  db: SupabaseClient,
  args: Pick<CheckDraftArgs, 'accountId' | 'userId' | 'conversationId'>
): Promise<ChatContext> {
  const { conversationId } = args;
  const [conv, msgs] = await Promise.all([
    db
      .from('conversations')
      .select('channel_id, send_channel_id')
      .eq('id', conversationId)
      .maybeSingle(),
    db
      .from('messages')
      .select('sender_type, content_text, status, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(MESSAGES_READ),
  ]);
  if (msgs.error)
    console.error('[insights] compose check: messages read failed');
  const messagesRead = !msgs.error;
  const messages = ((msgs.data as MessageRow[] | null) ?? []).reverse();
  const row = conv.data as {
    channel_id: string | null;
    send_channel_id: string | null;
  } | null;
  const channelId = row?.send_channel_id ?? row?.channel_id ?? null;
  if (!channelId) {
    // No number yet: the one a new chat of this person's starts from.
    // A failed conversations read is not "no number": unknown.
    const provider =
      row && !conv.error
        ? await newChatProvider(db, args.accountId, 'inbox', args.userId)
        : null;
    return { messages, messagesRead, provider };
  }
  const { data } = await db
    .from('whatsapp_config')
    .select('provider')
    .eq('id', channelId)
    .maybeSingle();
  const provider = (data as { provider?: unknown } | null)?.provider;
  return {
    messages,
    messagesRead,
    provider: typeof provider === 'string' ? provider : null,
  };
}

/** The deterministic warnings: nothing leaves the process. */
export function ruleWarnings(
  draft: string,
  customerTexts: readonly string[],
  partners: PartnerCatalogue
): ComposeWarningCode[] {
  const text = draft.slice(0, MAX_RULE_CHARS);
  const out: ComposeWarningCode[] = [];
  const nonPartner = detectBanksIn(text, partners.banks).filter(
    (b) => !b.partner
  );
  // A bank the customer named first is most likely being declined ("we
  // don't work with ADCB"), as in the guardrail's code layer.
  const named = new Set(
    customerTexts.flatMap((t) =>
      detectBanksIn(t.slice(0, MAX_RULE_CHARS), partners.banks).map(
        (b) => b.code
      )
    )
  );
  if (nonPartner.some((b) => !named.has(b.code))) out.push('non_partner_bank');
  if (regulatorClaims(text, partners.banks).length) out.push('regulator_claim');
  return out;
}

async function recordEvent(
  args: CheckDraftArgs,
  codes: ComposeWarningCode[]
): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin()
      .from('compose_check_events')
      .insert({
        account_id: args.accountId,
        user_id: args.userId,
        conversation_id: args.conversationId,
        warnings: codes,
      })
      .select('id')
      .single();
    if (error) {
      console.error(
        '[insights] compose check: event insert failed:',
        error.message
      );
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  } catch (err) {
    console.error(
      '[insights] compose check: event insert failed:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/** Warnings for an agent's draft. Never throws. */
export async function checkDraft(
  args: CheckDraftArgs
): Promise<ComposeCheckResult> {
  const now = args.now ?? Date.now;
  const deadlineAt = args.deadlineAt ?? now() + COMPOSE_CHECK_BUDGET_MS;
  try {
    const text = args.text;
    if (text.trim().length < COMPOSE_CHECK_MIN_CHARS) return NONE;
    if (!insightsAvailable(args.accountId)) return NONE;
    const ts = getDecisionLayer();
    if (!ts) return NONE;

    const [settings, partners, context] = await Promise.all([
      getInsightSettings(args.accountId),
      ts.partners(args.accountId),
      loadContext(args.db, args).catch((err: unknown) => {
        console.error(
          '[insights] compose check: context read failed:',
          err instanceof Error ? err.message : String(err)
        );
        return {
          messages: [],
          messagesRead: false,
          provider: null,
        } as ChatContext;
      }),
    ]);
    if (settings.composeCheckMode !== 'warn') return NONE;

    const isStart =
      context.messagesRead &&
      context.provider !== null &&
      isLinkedDeviceNumber(context.provider) &&
      wouldStartChat(context.messages, now());
    const withText = context.messages.filter((m) => m.content_text?.trim());
    const recentTurns = withText.slice(-RECENT_TURNS).map((m) => ({
      from:
        m.sender_type === 'customer'
          ? ('customer' as const)
          : ('business' as const),
      text: m.content_text!,
    }));
    const customerTexts = withText
      .filter((m) => m.sender_type === 'customer')
      .map((m) => m.content_text!);

    const found = new Map<ComposeWarningCode, ComposeWarning>();
    for (const code of ruleWarnings(text, customerTexts, partners))
      found.set(code, { code, source: 'rule' });

    const left = deadlineAt - now();
    if (left >= MIN_JEV_MS) {
      const j = await ts.composeCheck({
        accountId: args.accountId,
        draft: text,
        recentTurns,
        isStart,
        deadlineMs: left,
      });
      if (j.ok) {
        for (const code of composeCheckWarnings(j.figures, text))
          if (!found.has(code)) found.set(code, { code, source: 'jev' });
      } else if (j.errorCode !== 'DISABLED') {
        console.warn(
          `[insights] compose check: Jev ${j.errorCode}; rules only`
        );
      }
    }

    const warnings = COMPOSE_WARNING_CODES.flatMap((c) => {
      const w = found.get(c);
      return w ? [w] : [];
    });
    if (!warnings.length) return NONE;
    // Past the deadline the composer has given up and sent: a row now
    // would never get an outcome and would only inflate "pending".
    if (now() > deadlineAt) return { warnings, eventId: null };
    const eventId = await recordEvent(
      args,
      warnings.map((w) => w.code)
    );
    return { warnings, eventId };
  } catch (err) {
    console.error(
      '[insights] compose check failed:',
      err instanceof Error ? err.message : String(err)
    );
    return NONE;
  }
}
