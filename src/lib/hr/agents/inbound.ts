/**
 * Recruiter agents (package 026b): the inbound hook. Called from
 * `inbound-pipeline.ts` for every customer message, on company and
 * personal chats alike, awaited inside the route's after(). Most chats
 * are not HR candidate chats and stop at the first indexed read.
 *
 * Never throws. Drafts only: nothing here sends a message. A STOP is not
 * this hook's: the pipeline records it first (`./stop`).
 */
import { supabaseAdmin } from '@/lib/ai/admin-client';
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
  if (isOptOut(args.text)) return;
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
    if (row.inbox !== 'recruiter' || row.closed_at) return;

    const { data: setting, error: settingError } = await db
      .from('hr_agent_settings')
      .select('enabled')
      .eq('account_id', args.accountId)
      .eq('agent_kind', 'orchestrator')
      .maybeSingle();
    if (settingError) throw settingError;
    const orchestratorOn =
      (setting as { enabled: boolean } | null)?.enabled === true;

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
