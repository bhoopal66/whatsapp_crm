/**
 * The customer wrote in their one-to-one chat: the `customer_message` SLA
 * event on each open case of theirs that this chat is the only way to
 * answer: a lead, a submission opened without a WhatsApp group (136), or
 * one whose group has ended. A case with a live group hears it from the
 * group's own inbound path.
 *
 * One indexed read (`cases_account_contact_idx`) for a contact with no
 * such case. Never throws: the message is already in the inbox.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { CaseSlaStore } from './sla';

interface OpenCase {
  id: string;
  group_id: string | null;
  group: { wa_mode: string | null; status: string | null } | null;
}

/** Whether the customer can only answer in the one-to-one chat. */
export function answersOneToOne(c: OpenCase): boolean {
  if (!c.group_id) return true;
  return c.group?.wa_mode === 'none' || c.group?.status === 'ENDED';
}

export async function noteLeadCustomerMessage(
  admin: SupabaseClient,
  args: { accountId: string; contactId: string; messageRowId: string }
): Promise<void> {
  const failed = (what: string, error: unknown) =>
    console.error(
      `[cases] ${what} for inbound message ${args.messageRowId} failed:`,
      error instanceof Error ? error.message : 'unknown error'
    );
  try {
    const { data, error } = await admin
      .from('cases')
      .select(
        'id, group_id, group:submission_groups!cases_group_fkey(wa_mode, status)'
      )
      .eq('account_id', args.accountId)
      .eq('contact_id', args.contactId)
      .is('closed_at', null);
    if (error) throw new Error(error.message);
    const sla = new CaseSlaStore(admin);
    const open = ((data ?? []) as unknown as OpenCase[]).filter(
      answersOneToOne
    );
    for (const { id } of open) {
      try {
        await sla.customerMessageSystem(id);
      } catch (e) {
        failed(`case SLA of case ${id}`, e);
      }
    }
  } catch (e) {
    failed('the open lead lookup', e);
  }
}
