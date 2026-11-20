/**
 * HR lines (package 029b, migration 213): an inbound message on a number
 * an admin marked as an HR line, from someone with no HR chat yet, opens
 * a Recruitment chat, while the workspace switch is on.
 *
 * SQL decides everything (`hr_auto_open_recruiter`, service role): the
 * switch is its first and cheapest check, then the line, the chat,
 * whether an HR row already exists, and whether the chat ever used a
 * number that is not an HR line (one company chat per contact across
 * every number, so a sales customer's chat is never turned into a
 * Recruitment chat). This only calls it. Runs before the
 * recruiter-agents hook so a chat opened by this message gets its draft
 * on the same message.
 *
 * Never throws; logs one line on error, without the text or the phone.
 */
import { supabaseAdmin } from '@/lib/automations/admin-client';

/**
 * 'off' | 'not_hr_line' | 'not_found' | 'exists' | 'other_numbers' |
 * 'opened'; null on error.
 */
export async function autoOpenRecruiterChat(args: {
  conversationId: string;
  channelId: string;
}): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin().rpc(
      'hr_auto_open_recruiter',
      {
        p_conversation_id: args.conversationId,
        p_channel_id: args.channelId,
      }
    );
    if (error) {
      console.error('[hr-lines] auto-open failed:', error.message);
      return null;
    }
    return typeof data === 'string' ? data : null;
  } catch (err) {
    console.error(
      '[hr-lines] auto-open failed:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
