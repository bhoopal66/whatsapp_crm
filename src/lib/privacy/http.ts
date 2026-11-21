/**
 * Response helpers for the PDPL routes (`/api/privacy/*`). Refusals
 * answer `{ error, code }`; anything else is a 500 logged by function and
 * SQLSTATE only. Every response is `no-store`: it carries a customer's
 * personal data or the fact of a request about them.
 */
import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { isUuid } from '@/lib/cases/http';

import {
  PrivacyRefusedError,
  PrivacyStoreError,
  type PrivacyRefusal,
} from './store';

export const PRIVACY_REFUSAL_HTTP: Readonly<
  Record<PrivacyRefusal, { status: number; text: string }>
> = {
  NOT_ALLOWED: { status: 403, text: 'Owners and admins only' },
  NOT_FOUND: { status: 404, text: 'Customer not found' },
  INVALID: { status: 422, text: 'That request is not valid' },
  CONFIRM_REQUIRED: {
    status: 422,
    text: 'Type the confirmation exactly to erase',
  },
  REASON_REQUIRED: { status: 422, text: 'A reason is required' },
  LEGAL_HOLD: {
    status: 409,
    text: 'This customer is under a legal hold; nothing was erased',
  },
};

export class PrivacyBadRequest extends Error {
  override readonly name = 'PrivacyBadRequest';
}

export function noStore(res: NextResponse): NextResponse {
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export function privacyErrorResponse(
  err: unknown,
  label: string
): NextResponse {
  if (err instanceof PrivacyRefusedError) {
    const { status, text } = PRIVACY_REFUSAL_HTTP[err.reason];
    return noStore(
      NextResponse.json({ error: text, code: err.reason }, { status })
    );
  }
  if (err instanceof PrivacyBadRequest)
    return noStore(NextResponse.json({ error: err.message }, { status: 400 }));
  if (err instanceof PrivacyStoreError) {
    console.error(`[privacy] ${label}: ${err.fn} failed (${err.code ?? '-'})`);
    return noStore(
      NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    );
  }
  return noStore(toErrorResponse(err));
}

export async function readBody(
  request: Request
): Promise<Record<string, unknown>> {
  const body = (await request.json().catch(() => null)) as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new PrivacyBadRequest('Expected a JSON object');
  return body as Record<string, unknown>;
}

export function requireContactId(v: unknown): string {
  if (typeof v !== 'string' || !isUuid(v))
    throw new PrivacyBadRequest('contactId is not valid');
  return v;
}
