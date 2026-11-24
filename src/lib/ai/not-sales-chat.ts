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
