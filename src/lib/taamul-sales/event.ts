// ============================================================
// Taamul sales app — parsing one webhook body (migration 139).
//
// Pure: the route verifies the signature, then hands the parsed JSON
// here. Unknown fields are ignored, because the sales app may add new
// ones at any time; only what the CRM stores is read.
// ============================================================

import {
  validateContactPhone,
  withUaeCountryCode,
} from '@/lib/contacts/phone-validation';

export const INTERESTED_EVENT = 'contact.interested';
export const PING_EVENT = 'ping';

const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 500;
const MAX_NOTES_LENGTH = 5000;
const MAX_ADDITIONAL_PHONES = 20;

export interface InterestedEvent {
  eventId: string;
  eventType: typeof INTERESTED_EVENT;
  occurredAt: string;
  contact: {
    id: string;
    customerName: string | null;
    companyName: string | null;
    /** Digits with country code (971501234567); null when unusable. */
    phone: string | null;
    phoneRaw: string | null;
    /** Why `phone` is null although one was sent. */
    phoneError: string | null;
    additionalPhones: string[];
    tradeLicenseNumber: string | null;
    industry: string | null;
    area: string | null;
    city: string | null;
    isExistingCustomer: boolean | null;
  };
  agent: {
    id: string | null;
    username: string | null;
    fullName: string | null;
    email: string | null;
    team: string | null;
  };
  call: {
    feedbackId: string | null;
    calledAt: string | null;
    notes: string | null;
  };
  lead: {
    id: string | null;
    status: string | null;
    createdAt: string | null;
  };
}

export type ParsedEvent =
  | { kind: 'ping'; eventId: string | null }
  | { kind: 'ignored'; eventId: string | null; eventType: string }
  | { kind: 'interested'; event: InterestedEvent }
  | { kind: 'invalid'; error: string };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function text(value: unknown, max = MAX_TEXT_LENGTH): string | null {
  if (typeof value === 'number' && Number.isFinite(value))
    value = String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function id(value: unknown): string | null {
  const v = text(value, MAX_ID_LENGTH + 1);
  return v && v.length <= MAX_ID_LENGTH ? v : null;
}

function isoTime(value: unknown): string | null {
  const v = text(value, 64);
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * A sales-app number ("0501234567", UAE local with the trunk 0) as the
 * CRM stores numbers: digits with the country code. The sales app
 * normalises to UAE local format, so its country is known here, unlike
 * a number typed into a CRM form.
 */
export function normalizeSalesPhone(value: unknown): {
  phone: string | null;
  error: string | null;
} {
  const raw = text(value, 64);
  if (!raw) return { phone: null, error: null };
  const checked = validateContactPhone(withUaeCountryCode(raw), 'phone_number');
  return checked.ok
    ? { phone: checked.normalized, error: null }
    : { phone: null, error: checked.reason };
}

export function parseTaamulEvent(body: unknown): ParsedEvent {
  if (!isObj(body)) return { kind: 'invalid', error: 'body must be an object' };
  const eventType = text(body.event_type);
  const eventId = id(body.event_id);
  if (eventType === PING_EVENT) return { kind: 'ping', eventId };
  if (!eventType) return { kind: 'invalid', error: 'event_type is required' };
  // A new event type must not be retried for a day: acknowledge it.
  if (eventType !== INTERESTED_EVENT) {
    return { kind: 'ignored', eventId, eventType };
  }

  if (!eventId) return { kind: 'invalid', error: 'event_id is required' };
  const occurredAt = isoTime(body.occurred_at);
  if (!occurredAt) {
    return { kind: 'invalid', error: 'occurred_at must be an ISO-8601 time' };
  }
  const contact = isObj(body.contact) ? body.contact : null;
  const contactId = contact ? id(contact.id) : null;
  if (!contact || !contactId) {
    return { kind: 'invalid', error: 'contact.id is required' };
  }

  const primary = normalizeSalesPhone(contact.phone_number);
  const additional: string[] = [];
  if (Array.isArray(contact.additional_phones)) {
    for (const value of contact.additional_phones) {
      const { phone } = normalizeSalesPhone(value);
      if (phone && phone !== primary.phone && !additional.includes(phone)) {
        additional.push(phone);
      }
      if (additional.length >= MAX_ADDITIONAL_PHONES) break;
    }
  }

  const agent = isObj(body.agent) ? body.agent : {};
  const team = isObj(agent.team) ? agent.team : {};
  const call = isObj(body.call) ? body.call : {};
  const lead = isObj(body.lead) ? body.lead : {};
  const email = text(agent.email, 320);

  return {
    kind: 'interested',
    event: {
      eventId,
      eventType: INTERESTED_EVENT,
      occurredAt,
      contact: {
        id: contactId,
        customerName: text(contact.customer_name),
        companyName: text(contact.company_name),
        phone: primary.phone,
        phoneRaw: text(contact.phone_number, 64),
        phoneError: primary.error,
        additionalPhones: additional,
        tradeLicenseNumber: text(contact.trade_license_number),
        industry: text(contact.industry),
        area: text(contact.area),
        city: text(contact.city),
        isExistingCustomer:
          typeof contact.is_existing_customer === 'boolean'
            ? contact.is_existing_customer
            : null,
      },
      agent: {
        id: id(agent.id),
        username: text(agent.username),
        fullName: text(agent.full_name),
        email: email ? email.toLowerCase() : null,
        team: text(team.name),
      },
      call: {
        feedbackId: id(call.feedback_id),
        calledAt: isoTime(call.called_at),
        notes: text(call.notes, MAX_NOTES_LENGTH),
      },
      lead: {
        id: id(lead.id),
        status: text(lead.status),
        createdAt: isoTime(lead.created_at),
      },
    },
  };
}
