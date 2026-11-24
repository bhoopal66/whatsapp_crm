import type { SupabaseClient } from '@supabase/supabase-js';

import { isMissingFunction } from '@/lib/team-activity/db-errors';

/**
 * Why a chat is not the sales bot's to answer, or null: it sits in a
 * department inbox other than sales (192), it has an `hr_conversations`
 * row (200; a closed one too, the person is still a candidate or a
 * colleague), or the message came in on an HR line (213).
 *
 * `hr_lines` is readable only through functions: `hr_is_line` (279).
 * Before 279, `hr_auto_open_recruiter`, which the inbound pipeline calls
 * for every message anyway; it answers `off` without looking at the lines
 * while *Open a Recruitment chat* is off. Throws when a check cannot be
 * read.
 */
export async function notSalesChat(
  db: SupabaseClient,
  args: {
    conversationId: string;
    inboxDepartment: string | null;
    inboundChannelId: string | null;
    /** Look only: never fall back to `hr_auto_open_recruiter`, which may
     *  open an HR chat. A missing `hr_is_line` then throws. */
    readOnly?: boolean;
  }
): Promise<string | null> {
  if (args.inboxDepartment && args.inboxDepartment !== 'sales') {
    return `This chat is in the ${args.inboxDepartment} inbox.`;
  }
  const { data: hrRow, error: hrErr } = await db
    .from('hr_conversations')
    .select('conversation_id')
    .eq('conversation_id', args.conversationId)
    .maybeSingle();
  if (hrErr) throw new Error(`HR chat lookup: ${hrErr.message}`);
  if (hrRow) return 'This is an HR chat.';
  if (!args.inboundChannelId) return null;
  const onLine = 'The message came in on an HR line.';
  const { data: isLine, error: lineErr } = await db.rpc('hr_is_line', {
    p_channel: args.inboundChannelId,
  });
  if (!lineErr) return isLine === true ? onLine : null;
  if (args.readOnly || !isMissingFunction(lineErr)) {
    throw new Error(`HR line lookup: ${lineErr.message}`);
  }
  const { data: opened, error: openErr } = await db.rpc(
    'hr_auto_open_recruiter',
    {
      p_conversation_id: args.conversationId,
      p_channel_id: args.inboundChannelId,
    }
  );
  if (openErr) throw new Error(`HR line lookup: ${openErr.message}`);
  return opened === 'opened' ||
    opened === 'exists' ||
    opened === 'other_numbers'
    ? onLine
    : null;
}

/** The one decision about an inbound message's chat (`salesChatOnce`). */
export interface SalesChatDecision {
  /** A chat on a staff member's own number. */
  personal: boolean;
  /** Why this is not a sales chat, or null. */
  notSales: string | null;
  /** The check could not be read: sales answers stand down. */
  error: string | null;
}

export type SalesChatCheck = () => Promise<SalesChatDecision>;

/**
 * Whether the chat is a sales chat, read at most once per inbound
 * message: Flows, automations' message steps, journeys and the bot share
 * the answer, and an account with none of them on pays no read. Never
 * rejects.
 */
export function salesChatOnce(
  db: () => SupabaseClient,
  args: { conversationId: string; inboundChannelId: string | null }
): SalesChatCheck {
  let decision: Promise<SalesChatDecision> | null = null;
  return () => (decision ??= decideSalesChat(db, args));
}

async function decideSalesChat(
  db: () => SupabaseClient,
  args: { conversationId: string; inboundChannelId: string | null }
): Promise<SalesChatDecision> {
  try {
    const client = db();
    const { data, error } = await client
      .from('conversations')
      .select('personal_owner_id, inbox_department')
      .eq('id', args.conversationId)
      .maybeSingle();
    if (data?.personal_owner_id) {
      return { personal: true, notSales: null, error: null };
    }
    if (error) throw new Error(`department lookup: ${error.message}`);
    const notSales = await notSalesChat(client, {
      conversationId: args.conversationId,
      inboxDepartment: data?.inbox_department ?? null,
      inboundChannelId: args.inboundChannelId,
    });
    return { personal: false, notSales, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[sales chat] not checked, sales answers stand down:', {
      conversationId: args.conversationId,
      error: message,
    });
    return { personal: false, notSales: null, error: message };
  }
}

/**
 * Why the sales answers (Flows, journeys, automations' message steps)
 * must not go out in this chat, or null. No check given (no inbound
 * message is being handled) is no reason.
 */
export async function salesAnswersOff(
  check: SalesChatCheck | null | undefined
): Promise<string | null> {
  if (!check) return null;
  const d = await check();
  if (d.error) return 'Could not check whether this is a sales chat.';
  if (d.personal) return 'This is a personal chat.';
  return d.notSales;
}
