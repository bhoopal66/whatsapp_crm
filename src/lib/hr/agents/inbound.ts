/**
 * Recruiter agents (package 026b): the inbound hook. Called from
 * `inbound-pipeline.ts` for every customer message, on company and
 * personal chats alike, awaited inside the route's after(). Most chats
 * are not HR candidate chats and stop at the first indexed read.
 *
 * Never throws. Drafts only: nothing here sends a message.
 */
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { markOptedOut } from '@/lib/ai/opt-out';
import { isOptOut } from './guardrails';
import { runHrAgents } from './server';

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
    if (
      !row ||
      row.account_id !== args.accountId ||
      row.inbox !== 'recruiter' ||
      row.closed_at
    ) {
      return;
    }

    const { data: setting, error: settingError } = await db
      .from('hr_agent_settings')
      .select('enabled')
      .eq('account_id', args.accountId)
      .eq('agent_kind', 'orchestrator')
      .maybeSingle();
    if (settingError) throw settingError;
    const orchestratorOn =
      (setting as { enabled: boolean } | null)?.enabled === true;

    if (isOptOut(args.text)) {
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
      await markOptedOut(db, {
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
