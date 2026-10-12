import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { ensureOpenFile } from '@/lib/journeys/host/store';
import {
  WORKFLOWS,
  fail,
  isRecord,
  isUuid,
  runJourneyEvent,
} from '../run-event';

export const maxDuration = 60;

/**
 * Starts the journey bot for a customer from the CRM (a cold start: the
 * opt-in welcome template, then the menu). Body `{ contactId }`.
 *
 * Refused with 409 unless the customer gave a recorded marketing opt-in
 * and has neither opted out nor been marked do-not-contact, and unless
 * the account switched the bot on. The contact is read with the caller's
 * RLS client, so an agent starts journeys only for customers they can
 * see; the file and the event are the service role's. A customer whose
 * open journey is already under way gets a 200 with the engine's
 * ALREADY_STARTED warning and no change.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const body: unknown = await request.json().catch(() => null);
    if (!isRecord(body) || !isUuid(body.contactId))
      return fail(400, 'contactId must be a contact id');
    const contactId = body.contactId;

    const { data, error } = await supabase
      .from('contacts')
      .select('id, marketing_opt_in_at, opted_out_at, do_not_contact_at')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw new Error(`contacts: ${error.message}`);
    const contact = data as {
      marketing_opt_in_at: string | null;
      opted_out_at: string | null;
      do_not_contact_at: string | null;
    } | null;
    if (!contact) return fail(404, 'Contact not found');
    if (contact.opted_out_at)
      return fail(409, 'This customer has opted out', 'OPTED_OUT');
    if (contact.do_not_contact_at)
      return fail(409, 'This customer is on do-not-contact', 'DO_NOT_CONTACT');
    if (!contact.marketing_opt_in_at)
      return fail(
        409,
        'This customer has no recorded marketing opt-in',
        'NO_MARKETING_OPT_IN'
      );

    const { data: s, error: sErr } = await supabase
      .from('journey_settings')
      .select('enabled, workflow_key')
      .eq('account_id', accountId)
      .maybeSingle();
    if (sErr) throw new Error(`journey_settings: ${sErr.message}`);
    const settings = s as { enabled: boolean; workflow_key: string } | null;
    if (!settings?.enabled)
      return fail(
        409,
        'The journey bot is switched off for this account',
        'JOURNEYS_DISABLED'
      );
    const def = WORKFLOWS[settings.workflow_key];
    if (!def)
      return fail(
        409,
        `Unknown journey workflow (${settings.workflow_key})`,
        'UNKNOWN_WORKFLOW'
      );

    const db = supabaseAdmin();
    const fileId = await ensureOpenFile(db, {
      accountId,
      contactId,
      workflowKey: settings.workflow_key,
    });
    return await runJourneyEvent(
      db,
      def,
      fileId,
      { type: 'START_COLD', at: new Date().toISOString() },
      { fileId }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
