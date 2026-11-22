/**
 * Reading and checking one public web form submission (migration 249,
 * docs/web-form.md). Pure: the route does the I/O.
 *
 * The phone goes through the same rule as every typed number
 * (`validateContactPhone`), so the database receives international
 * digits, the form `phone_normalized` indexes.
 */

import { validateContactPhone } from '@/lib/contacts/phone-validation';

/** Largest body read, in bytes. A real submission is well under 3 KB. */
export const MAX_BODY_BYTES = 8 * 1024;

export const FIELD_LIMITS = {
  name: 120,
  phone: 64,
  email: 254,
  message: 2000,
  page_url: 500,
} as const;

/** The hidden field a person never sees and a bot fills in. */
export const HONEYPOT_FIELD = 'website';

export type BodyKind = 'json' | 'form';

/** Which body the request carries, or null for anything else (415). */
export function bodyKindOf(contentType: string | null): BodyKind | null {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json') return 'json';
  if (type === 'application/x-www-form-urlencoded') return 'form';
  return null;
}

/** The raw fields as strings; anything not a string is dropped. */
export function readFields(
  kind: BodyKind,
  text: string
): Record<string, string> | null {
  const out: Record<string, string> = {};
  if (kind === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  }
  for (const [key, value] of new URLSearchParams(text)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

export function isHoneypotFilled(fields: Record<string, string>): boolean {
  return (fields[HONEYPOT_FIELD] ?? '').trim() !== '';
}

export type SubmissionError =
  'phone_required' | 'bad_phone' | 'bad_email' | 'too_long';

export interface CleanSubmission {
  name: string | null;
  /** International digits, no '+'. */
  phone: string;
  email: string | null;
  message: string | null;
  pageUrl: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value: string | undefined): string | null {
  const cleaned = (value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  return cleaned ? cleaned : null;
}

/**
 * The fields the form takes, checked. An over-long field is refused
 * rather than cut (the visitor can see and fix it); `page_url` is the
 * only field quietly dropped when it is not an http(s) URL, because the
 * visitor never typed it.
 */
export function validateSubmission(
  fields: Record<string, string>,
  referer: string | null = null
):
  | { ok: true; value: CleanSubmission }
  | { ok: false; error: SubmissionError; field: string } {
  const name = text(fields.name);
  const phoneRaw = text(fields.phone);
  const email = text(fields.email);
  const message = text(fields.message);

  if (name && name.length > FIELD_LIMITS.name) {
    return { ok: false, error: 'too_long', field: 'name' };
  }
  if (email && email.length > FIELD_LIMITS.email) {
    return { ok: false, error: 'too_long', field: 'email' };
  }
  if (message && message.length > FIELD_LIMITS.message) {
    return { ok: false, error: 'too_long', field: 'message' };
  }
  if (!phoneRaw) return { ok: false, error: 'phone_required', field: 'phone' };
  if (phoneRaw.length > FIELD_LIMITS.phone) {
    return { ok: false, error: 'bad_phone', field: 'phone' };
  }
  const phone = validateContactPhone(phoneRaw);
  if (!phone.ok) return { ok: false, error: 'bad_phone', field: 'phone' };
  if (email && !EMAIL.test(email)) {
    return { ok: false, error: 'bad_email', field: 'email' };
  }

  const pageRaw = text(fields.page_url) ?? referer;
  let pageUrl: string | null = null;
  if (pageRaw && pageRaw.length <= FIELD_LIMITS.page_url) {
    try {
      const url = new URL(pageRaw);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        // Query strings carry tracking ids and sometimes personal data.
        pageUrl = `${url.origin}${url.pathname}`;
      }
    } catch {
      pageUrl = null;
    }
  }

  return {
    ok: true,
    value: {
      name,
      phone: phone.normalized,
      email: email ? email.toLowerCase() : null,
      message,
      pageUrl,
    },
  };
}

/** A 64-hex token, the only shape the database issues. */
export function isWellFormedToken(token: string): boolean {
  return /^[0-9a-f]{64}$/.test(token);
}
