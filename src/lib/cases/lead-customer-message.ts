/**
 * The customer wrote in their one-to-one chat: the `customer_message` SLA
 * event on each open case they have with no submission group (a lead). A
 * case with a group hears it from the group's own inbound path.
 *
 * One indexed read (`cases_account_contact_idx`) for a contact with no
 * such case. Never throws: the message is already in the inbox.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { CaseSlaStore } from './sla';

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
      .select('id')
      .eq('account_id', args.accountId)
      .eq('contact_id', args.contactId)
      .is('group_id', null)
      .is('closed_at', null);
    if (error) throw new Error(error.message);
    const sla = new CaseSlaStore(admin);
    for (const { id } of (data ?? []) as { id: string }[]) {
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
