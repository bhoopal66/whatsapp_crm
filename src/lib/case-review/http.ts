/**
 * Refusals of the case review routes (migration 225) as `{ error, code }`.
 * Anything else is a 500 logged by function and SQLSTATE only.
 */
import { NextResponse } from 'next/server';

import { caseErrorResponse } from '@/lib/cases/http';

const REFUSALS: Readonly<Record<string, { status: number; text: string }>> = {
  CASE_NOT_FOUND: { status: 404, text: 'Case not found' },
  DRAFT_NOT_FOUND: { status: 404, text: 'Draft not found' },
  NOT_ALLOWED: { status: 403, text: 'Not allowed' },
  ALREADY_DECIDED: { status: 409, text: 'This draft was already decided' },
  INVALID: { status: 422, text: 'That request is not valid' },
  SETTING_INVALID: {
    status: 422,
    text: 'The AI narrative needs the reviewer on',
  },
};

export class ReviewRefused extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Throws ReviewRefused for a known hint, else a plain error. */
export function check(
  fn: string,
  error: { code?: string; hint?: string | null } | null
): void {
  if (!error) return;
  if (typeof error.hint === 'string' && error.hint in REFUSALS)
    throw new ReviewRefused(error.hint);
  throw Object.assign(new Error(`${fn} failed`), {
    sqlstate: error.code ?? null,
    fn,
  });
}

export function reviewErrorResponse(err: unknown, label: string): NextResponse {
  if (err instanceof ReviewRefused) {
    const r = REFUSALS[err.code]!;
    return NextResponse.json(
      { error: r.text, code: err.code },
      { status: r.status }
    );
  }
  const e = err as { fn?: string; sqlstate?: string | null };
  if (e?.fn) {
    console.error(
      `[case-review] ${label}: ${e.fn} failed (${e.sqlstate ?? '-'})`
    );
    return NextResponse.json(
      { error: 'Something went wrong' },
      { status: 500 }
    );
  }
  return caseErrorResponse(err, label);
}
