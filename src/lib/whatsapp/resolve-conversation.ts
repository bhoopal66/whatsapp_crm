// ============================================================
// Resolve (or create) the conversation for a phone number.
//
// The dashboard composer always has a `conversation_id` in hand. The
// public API doesn't — an external automation knows a *phone number*,
// not an internal UUID. This helper bridges that: given an E.164
// phone, it finds-or-creates the contact and its conversation so the
// shared `sendMessageToConversation` core can run unchanged.
//
// It deliberately reuses the exact find-or-create logic the inbound
// webhook uses (the `findExistingContact` dedupe helper, the
// one-conversation-per-(account, contact) convention, the
// account_id-tenancy / user_id-audit split) so a contact created via
// the API is indistinguishable from one created by an inbound message.
//
// Audit user: created rows need a NOT NULL `user_id`. As with the
// webhook (where there's no logged-in human either), we attribute
// them to the WhatsApp config owner — a stable account-level default.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { validateContactPhone } from '@/lib/contacts/phone-validation';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';

export interface ResolvedConversation {
  conversationId: string;
  contactId: string;
  /** True if this call created the contact (vs matched an existing one). */
  contactCreated: boolean;
  /** True if this call created the conversation (no chat existed yet). */
  conversationCreated: boolean;
}

export interface ResolveConversationOptions {
  /**
   * Overwrite an existing contact's name with `name` (default true, the
   * public API's long-standing behaviour). The Compass notifications
   * pass false: the ERP's spelling must not clobber a name an agent
   * has curated on a contact they already work.
   */
  renameExisting?: boolean;
}

/**
 * Find or create the contact + conversation for `phone` within
 * `accountId`. Throws `SendMessageError` (shared with the send core,
 * so the route maps one error family) on a bad phone, a missing
 * WhatsApp config, or a DB failure.
 *
 * An existing contact is found by the last-8 match below, whatever
 * shape its number was saved in. A new one is held to the rule every
 * other entry point uses (`validateContactPhone`): the E.164 check
 * alone let "504555843" and "+9710501234567" become contacts here,
 * each send was 'sent' to a JID that is nobody, and the customer's
 * real inbound later attached itself to that row.
 */
export async function resolveConversationByPhone(
  db: SupabaseClient,
  accountId: string,
  phone: string,
  name?: string | null,
  { renameExisting = true }: ResolveConversationOptions = {}
): Promise<ResolvedConversation> {
  const sanitized = sanitizePhoneForMeta(phone);
  if (!isValidE164(sanitized)) {
    throw new SendMessageError(
      'bad_request',
      "'to' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400
    );
  }
  const checked = validateContactPhone(phone, "'to'");
  // Spreadsheet notation, a ".0" float suffix or a letter in the
  // number means its digits are not the number anyone meant, so they
  // must not reach the last-8 match either: it could land on an
  // unrelated contact who happens to share eight of them.
  if (
    !checked.ok &&
    (checked.reason === 'scientific_notation' || checked.reason === 'malformed')
  ) {
    throw new SendMessageError('bad_request', checked.error, 400);
  }

  // Fail fast (and create nothing) when the account has no WhatsApp
  // connected — the same error the send would raise anyway.
  const { data: config } = await db
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    // Any connected channel satisfies this precheck, and an account may
    // now have two — so take one rather than asserting there is exactly
    // one. Without the limit, maybeSingle() errors and a perfectly
    // configured account reports "WhatsApp not configured".
    .limit(1)
    .maybeSingle();
  if (!config) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  // Audit user for created rows = the single account-wide default used
  // by every public-API write (see resolveAuditUserId), so a contact
  // created here is attributed identically to one created via
  // POST /api/v1/contacts. resolveAuditUserId throws ContactError only
  // if the owner can't be resolved — remap it to the send error family
  // the callers already handle.
  let ownerUserId: string;
  try {
    ownerUserId = await resolveAuditUserId(db, accountId);
  } catch (err) {
    if (err instanceof ContactError) {
      throw new SendMessageError('db_error', err.message, err.status);
    }
    throw err;
  }

  // ---- contact -------------------------------------------------
  let contactId: string;
  let contactCreated = false;

  // Look up by the number the rule reads, not the typed digits: a
  // trunk 0 inside the last eight ("+961 03 123 456" types 03123456,
  // the number is 9613123456) otherwise misses the real contact and
  // the last-8 match lands on an unrelated one that shares the typed
  // tail (971503123456) — and the send goes to that person. A number
  // the rule refuses keeps the raw digits, so a legacy "504555843"
  // row is still found.
  const existing = await findExistingContact(
    db,
    accountId,
    checked.ok ? checked.normalized : sanitized
  );
  if (existing) {
    contactId = existing.id;
    if (renameExisting && name && name !== existing.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    }
  } else {
    if (!checked.ok) {
      throw new SendMessageError('bad_request', checked.error, 400);
    }
    // Stored normalized (digits, country code, no trunk 0), the form
    // the inbound webhooks store, so the customer's reply finds this
    // row by an exact match.
    const normalized = checked.normalized;
    const { data: created, error: createErr } = await db
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: ownerUserId,
        phone: normalized,
        name: name || normalized,
      })
      .select('id')
      .single();

    if (createErr || !created) {
      // Lost a race against a concurrent inbound/API create — the
      // unique index (migration 022) rejected the duplicate. Re-resolve.
      if (isUniqueViolation(createErr)) {
        const raced = await findExistingContact(db, accountId, normalized);
        if (raced) {
          contactId = raced.id;
        } else {
          throw new SendMessageError(
            'db_error',
            'Failed to create contact',
            500
          );
        }
      } else {
        console.error(
          '[resolve-conversation] contact create error:',
          createErr
        );
        throw new SendMessageError('db_error', 'Failed to create contact', 500);
      }
    } else {
      contactId = created.id;
      contactCreated = true;
    }
  }

  // ---- conversation -------------------------------------------
  // One conversation per (account, contact) — same convention as the
  // webhook. Order oldest-first and take one row rather than
  // `.maybeSingle()`, which errors on ≥2 rows: if duplicates predate the
  // unique index (migration 036), we resolve to the canonical survivor
  // instead of falling through and creating yet another (issue #363).
  const { id: conversationId, created: conversationCreated } =
    await findOrCreateConversationRow(db, accountId, contactId, ownerUserId);

  return { conversationId, contactId, contactCreated, conversationCreated };
}

/**
 * Find (oldest-first) or create the single conversation for
 * `(accountId, contactId)`. Handles the unique-index race the same way
 * the inbound webhook does: on a 23505 from a concurrent create,
 * re-resolve the winning row rather than failing the send.
 */
async function findOrCreateConversationRow(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  ownerUserId: string
): Promise<{ id: string; created: boolean }> {
  const { data: existing, error: findErr } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findErr) {
    console.error('[resolve-conversation] conversation lookup error:', findErr);
    throw new SendMessageError(
      'db_error',
      'Failed to resolve conversation',
      500
    );
  }

  if (existing && existing.length > 0) {
    return { id: existing[0].id, created: false };
  }

  const { data: newConv, error: convErr } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
    })
    .select('id')
    .single();

  if (convErr || !newConv) {
    if (isUniqueViolation(convErr)) {
      const { data: raced } = await db
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) {
        return { id: raced[0].id, created: false };
      }
    }
    console.error('[resolve-conversation] conversation create error:', convErr);
    throw new SendMessageError(
      'db_error',
      'Failed to create conversation',
      500
    );
  }

  return { id: newConv.id, created: true };
}
