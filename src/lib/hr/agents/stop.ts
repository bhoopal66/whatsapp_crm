/**
 * A candidate's STOP (`isOptOut`) on an HR chat or an HR line: stamped on
 * the contact whatever the HR switches say, so switching agents or
 * automated messages on later never reaches someone who already said
 * stop. The pipeline calls this right after the `messages` idempotency
 * boundary, before the reactions and for a rate-limited sender too.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { markOptedOut } from '@/lib/ai/opt-out';
import { isOptOut } from './guardrails';

const TRIES = 3;

export interface HrStopArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  /** The number the message arrived on. */
  channelId: string;
  text: string;
  /** A retried delivery: the stamp only, nothing else a second time. */
  retry?: boolean;
}

/** An install without the HR table (200) has no HR chat. */
const tableMissing = (error: { code?: string }) =>
  error.code === 'PGRST205' || error.code === '42P01';

/** An install without `hr_is_line` (279) has no HR line. */
const functionMissing = (error: { code?: string }) =>
  error.code === 'PGRST202' || error.code === '42883';

/**
 * `hr_lines` is readable only through `hr_is_line`: nobody, the service
 * role included, has SELECT on it.
 */
async function isHr(db: SupabaseClient, args: HrStopArgs): Promise<boolean> {
  const chat = await db
    .from('hr_conversations')
    .select('conversation_id')
    .eq('conversation_id', args.conversationId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (chat.error && !tableMissing(chat.error)) throw chat.error;
  if (!chat.error && chat.data) return true;
  const line = await db.rpc('hr_is_line', { p_channel: args.channelId });
  if (line.error && !functionMissing(line.error)) throw line.error;
  return !line.error && line.data === true;
}

/**
 * One try. `markOptedOut` answers false for "already stamped" and for
 * "the write failed": the stamp is read to tell them apart. A contact
 * that is gone has nothing to stamp.
 */
async function stamp(db: SupabaseClient, args: HrStopArgs): Promise<boolean> {
  const who = { accountId: args.accountId, contactId: args.contactId };
  if (await markOptedOut(db, who)) return true;
  const { data, error } = await db
    .from('contacts')
    .select('opted_out_at')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (error) throw error;
  return (
    !data || (data as { opted_out_at: string | null }).opted_out_at !== null
  );
}

/**
 * False only when a STOP is owed a stamp and did not get one: the caller
 * must let the delivery be retried. Never throws.
 */
export async function recordHrStop(
  db: SupabaseClient,
  args: HrStopArgs
): Promise<boolean> {
  if (!isOptOut(args.text)) return true;
  let recorded = false;
  for (let i = 0; i < TRIES && !recorded; i++) {
    try {
      if (!(await isHr(db, args))) return true;
      recorded = await stamp(db, args);
    } catch (err) {
      console.error(
        '[hr agents] recording a STOP failed:',
        (err as { code?: unknown } | null)?.code ?? err
      );
    }
  }
  if (!recorded) {
    console.error(
      `[hr agents] OPT-OUT NOT RECORDED for contact ${args.contactId}: the customer asked to stop and may still be messaged`
    );
  }
  if (!args.retry) {
    try {
      const { error } = await db.rpc('hr_agent_supersede', {
        p_account_id: args.accountId,
        p_contact_id: args.contactId,
      });
      if (error) throw error;
    } catch (err) {
      console.error('[hr agents] supersede after a STOP failed:', err);
    }
  }
  return recorded;
}
