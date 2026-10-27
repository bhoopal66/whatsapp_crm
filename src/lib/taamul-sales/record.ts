// ============================================================
// Taamul sales app (OpenDesk) — storing one "contact marked as
// interested" event (migration 139, docs/taamul-sales.md).
//
// Like Compass customers (056), these are kept in their own table,
// taamul_sales_contacts, and never written into the CRM's `contacts`:
// admins see them under OpenDesk. taamul_sales_record_interested()
// claims the event id and upserts the sales-app contact in one
// transaction, so a failure leaves nothing behind and the sales app
// redelivers; a replayed event id comes back 'duplicate' untouched.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { InterestedEvent } from './event';

export type RecordOutcome = 'recorded' | 'duplicate';

/** Carries a Postgres/PostgREST code, never row values (they hold PII). */
export class TaamulSalesError extends Error {
  constructor(step: string, code?: string) {
    super(`${step} failed${code ? ` (${code})` : ''}`);
    this.name = 'TaamulSalesError';
  }
}

export async function recordInterested(
  db: SupabaseClient,
  accountId: string,
  event: InterestedEvent,
  opts: { deliveryId?: string | null; payload: unknown }
): Promise<RecordOutcome> {
  const { contact, agent, call, lead } = event;
  const { data, error } = await db.rpc('taamul_sales_record_interested', {
    p_account_id: accountId,
    p_event_id: event.eventId,
    p_event_type: event.eventType,
    p_occurred_at: event.occurredAt,
    p_taamul_contact_id: contact.id,
    p_fields: {
      customer_name: contact.customerName,
      company_name: contact.companyName,
      phone: contact.phone,
      phone_raw: contact.phoneRaw,
      additional_phones: contact.additionalPhones,
      trade_license_number: contact.tradeLicenseNumber,
      industry: contact.industry,
      area: contact.area,
      city: contact.city,
      is_existing_customer: contact.isExistingCustomer,
      agent_id: agent.id,
      agent_username: agent.username,
      agent_name: agent.fullName,
      agent_email: agent.email,
      agent_team: agent.team,
      call_feedback_id: call.feedbackId,
      called_at: call.calledAt,
      call_notes: call.notes,
      lead_id: lead.id,
      lead_status: lead.status,
      lead_created_at: lead.createdAt,
    },
    p_payload: opts.payload,
    p_delivery_id: opts.deliveryId?.slice(0, 200) ?? null,
  });
  if (error) throw new TaamulSalesError('record', error.code);
  return data === 'duplicate' ? 'duplicate' : 'recorded';
}
