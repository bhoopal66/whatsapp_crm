/**
 * Recruiter agents (package 026b): the inbound hook. Called from
 * `inbound-pipeline.ts` for every customer message, on company and
 * personal chats alike, awaited inside the route's after(). Most chats
 * are not HR candidate chats and stop at the first indexed read.
 *
 * Never throws. Drafts only: nothing here sends a message.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/ai/admin-client';
import { markOptedOut } from '@/lib/ai/opt-out';
import { isOptOut } from './guardrails';
import { runHrAgents } from './server';

/**
 * `markOptedOut` answers false both for "already stamped" and for "the
 * write failed": read the stamp to tell them apart, try once more, and
 * say so when a STOP could not be recorded.
 */
async function stampOptOut(
  db: SupabaseClient,
  who: { accountId: string; contactId: string }
): Promise<void> {
  if (await markOptedOut(db, who)) return;
  if (await isStamped(db, who)) return;
  if (await markOptedOut(db, who)) return;
  if (await isStamped(db, who)) return;
  console.error(
    `[hr agents] OPT-OUT NOT RECORDED for contact ${who.contactId}: the customer asked to stop and may still be messaged`
  );
}

async function isStamped(
  db: SupabaseClient,
  who: { accountId: string; contactId: string }
): Promise<boolean> {
  const { data, error } = await db
    .from('contacts')
    .select('opted_out_at')
    .eq('id', who.contactId)
    .eq('account_id', who.accountId)
    .maybeSingle();
  if (error) return false;
  return (data as { opted_out_at: string | null } | null)?.opted_out_at != null;
}

export async function handleHrInboundMessage(args: {
  accountId: string;
  conversationId: string;
  contactId: string;
  /** Our `messages.id`, not the gateway's message id. */
  messageId: string;
  text: string;
}): Promise<void> {
  try {
    const db = supabaseAdmin();
    const { data: hr, error: hrError } = await db
      .from('hr_conversations')
      .select('account_id, inbox, closed_at')
      .eq('conversation_id', args.conversationId)
      .maybeSingle();
    if (hrError) throw hrError;
    const row = hr as {
      account_id: string;
      inbox: string;
      closed_at: string | null;
    } | null;
    if (!row || row.account_id !== args.accountId) return;
    // A STOP counts in a closed chat and in the department inbox too: the
    // stamp is the contact's, and their other chats read it.
    const optOut = isOptOut(args.text);
    if (!optOut && (row.inbox !== 'recruiter' || row.closed_at)) return;

    const { data: setting, error: settingError } = await db
      .from('hr_agent_settings')
      .select('enabled')
      .eq('account_id', args.accountId)
      .eq('agent_kind', 'orchestrator')
      .maybeSingle();
    if (settingError) throw settingError;
    const orchestratorOn =
      (setting as { enabled: boolean } | null)?.enabled === true;

    if (optOut) {
      // An opt-out is honoured only once the account uses agents or
      // automated messages; with both off this hook changes nothing.
      let active = orchestratorOn;
      if (!active) {
        const { data, error } = await db.rpc('hr_automsg_active', {
          p_account_id: args.accountId,
        });
        if (error) throw error;
        active = data === true;
      }
      if (!active) return;
      await stampOptOut(db, {
        accountId: args.accountId,
        contactId: args.contactId,
      });
      const { error } = await db.rpc('hr_agent_supersede', {
        p_account_id: args.accountId,
        p_contact_id: args.contactId,
      });
      if (error) throw error;
      return;
    }

    if (!orchestratorOn || !args.text.trim()) return;
    await runHrAgents(db, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      sourceMessageId: args.messageId,
      actorUserId: null,
    });
  } catch (err) {
    console.error('[hr agents] inbound hook failed:', err);
  }
}
