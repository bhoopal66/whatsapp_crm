/**
 * Request / response helpers for the case desk routes (`/api/desk/*`,
 * migration 220): refusal -> HTTP, body parsing, the error response.
 * Refusals answer `{ error, code }`; anything else is a 500 logged by
 * function and SQLSTATE only, never database text.
 *
 * TENANCY: every route works in the caller's ACTIVE account
 * (`getCurrentAccount`), passed to the store, which the SQL confines to.
 */
import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { isUuid } from '@/lib/cases/http';

import {
  DeskRefusedError,
  DeskStoreError,
  type DeskRefusal,
  type ItemKind,
  type ItemTags,
} from './store';

export const DESK_REFUSAL_HTTP: Readonly<
  Record<DeskRefusal, { status: number; text: string }>
> = {
  INVALID: { status: 422, text: 'That request is not valid' },
  NOT_ALLOWED: { status: 403, text: 'Not allowed' },
  BANK_SCOPE: { status: 403, text: 'That queue belongs to another bank' },
  BANK_UNKNOWN: { status: 422, text: 'Unknown bank' },
  BANK_CODE_MISSING: {
    status: 422,
    text: 'The bank has no desk code yet; an admin sets it',
  },
  CODE_TAKEN: { status: 409, text: 'That desk code cannot be used' },
  SEQ_EXHAUSTED: { status: 409, text: 'Case numbers are exhausted' },
  SUFFIX_EXHAUSTED: {
    status: 409,
    text: 'Nine cases at this bank in one application',
  },
  CASE_CONFLICT: {
    status: 409,
    text: 'This customer already has a different open case at this bank',
  },
  NO_CONTACT: { status: 422, text: 'Choose the customer contact first' },
  FILE_INVALID: { status: 422, text: 'The file could not be accepted' },
  ITEM_NOT_FOUND: { status: 404, text: 'Upload not found' },
  ITEM_NOT_OPEN: { status: 409, text: 'This upload was already sorted' },
  CASE_NOT_FOUND: { status: 404, text: 'Case not found' },
  CASE_CLOSED: { status: 409, text: 'The case is closed' },
  NO_FILE: { status: 422, text: 'A pending document needs a file' },
  REASON_REQUIRED: { status: 422, text: 'A reason is required' },
  LEAD_INVALID: {
    status: 422,
    text: 'The uploader cannot see that contact, or the details are invalid',
  },
  LEAD_EXISTS: {
    status: 409,
    text: 'Another agent already has an open lead for this contact and bank',
  },
  CASE_EXISTS: {
    status: 409,
    text: 'This contact already has a submitted case at this bank',
  },
  ASSIGNEE_INVALID: {
    status: 422,
    text: 'The uploader is no longer live staff',
  },
  CUSTOMER_NOT_FOUND: { status: 404, text: 'Company not found' },
  CONTACT_INVALID: { status: 422, text: 'Choose a contact you can see' },
  TRAY_NOT_FOUND: { status: 404, text: 'Not found in the tray' },
  TRAY_NOT_OPEN: { status: 409, text: 'This document was already sorted' },
  FILE_NOT_FOUND: { status: 404, text: 'File not found' },
  CROSS_CUSTOMER: {
    status: 422,
    text: 'That case belongs to another company',
  },
  CONSENT_MISSING: {
    status: 409,
    text: 'The company has not agreed to reuse its documents at that bank',
  },
  CONSENT_NOT_FOUND: { status: 404, text: 'No consent recorded for that bank' },
  CONFIRM_COMPANY: {
    status: 422,
    text: "Type the company's legal name to confirm this case",
  },
};

/** A body or form field the route refuses before any database call. */
export class DeskBadRequest extends Error {
  override readonly name = 'DeskBadRequest';
}

export function deskErrorResponse(err: unknown, label: string): NextResponse {
  if (err instanceof DeskRefusedError) {
    const { status, text } = DESK_REFUSAL_HTTP[err.reason];
    return NextResponse.json({ error: text, code: err.reason }, { status });
  }
  if (err instanceof DeskBadRequest)
    return NextResponse.json({ error: err.message }, { status: 400 });
  if (err instanceof DeskStoreError) {
    console.error(`[desk] ${label}: ${err.fn} failed (${err.code ?? '-'})`);
    return NextResponse.json(
      { error: 'Something went wrong' },
      { status: 500 }
    );
  }
  return toErrorResponse(err);
}

const KINDS: readonly ItemKind[] = ['new_case', 'pending_doc', 'info'];

function text(v: unknown, max: number, name: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new DeskBadRequest(`${name} must be text`);
  const t = v.trim();
  if (t === '') return null;
  if (t.length > max) throw new DeskBadRequest(`${name} is too long`);
  return t;
}

function uuidOrNull(v: unknown, name: string): string | null {
  const t = text(v, 36, name);
  if (t !== null && !isUuid(t))
    throw new DeskBadRequest(`${name} is not valid`);
  return t;
}

/** The tag fields of an upload or a retag (a FormData's or JSON's values). */
export function parseTags(get: (name: string) => unknown): ItemTags {
  const kind = text(get('kind'), 20, 'kind');
  if (kind !== null && !KINDS.includes(kind as ItemKind))
    throw new DeskBadRequest('kind is not valid');
  const docKey = text(get('docKey'), 64, 'docKey');
  if (docKey !== null && !/^[a-z0-9_]{1,64}$/.test(docKey))
    throw new DeskBadRequest('docKey is not valid');
  return {
    kind: kind as ItemKind | null,
    bankCode: text(get('bankCode'), 32, 'bankCode'),
    caseRef: text(get('caseRef'), 40, 'caseRef'),
    companyName: text(get('companyName'), 200, 'companyName'),
    tradeLicence: text(get('tradeLicence'), 64, 'tradeLicence'),
    product: text(get('product'), 200, 'product'),
    contactId: uuidOrNull(get('contactId'), 'contactId'),
    docKey,
    note: text(get('note'), 4000, 'note'),
  };
}

/** 8-80 characters of A-Z a-z 0-9 _ : . - (the SQL's rule). */
export function parseIdemKey(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_:.-]{8,80}$/.test(v))
    throw new DeskBadRequest('idemKey is not valid');
  return v;
}

export function requireUuid(v: unknown, name: string): string {
  const t = uuidOrNull(v, name);
  if (t === null) throw new DeskBadRequest(`${name} is required`);
  return t;
}

export function requireText(v: unknown, max: number, name: string): string {
  const t = text(v, max, name);
  if (t === null) throw new DeskBadRequest(`${name} is required`);
  return t;
}

export { text as optionalText };

export async function readJson(
  request: Request
): Promise<Record<string, unknown>> {
  const body = (await request.json().catch(() => null)) as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new DeskBadRequest('Expected a JSON object');
  return body as Record<string, unknown>;
}
