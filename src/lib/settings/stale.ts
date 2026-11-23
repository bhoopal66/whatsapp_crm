import { NextResponse } from 'next/server';

/**
 * Was a settings form loaded from an older row than the one stored?
 * `expected` is the `expectedUpdatedAt` of the request body: the row's
 * `updated_at` as the form read it, null when there was no row. A client
 * that sends none (older build) is never refused.
 */
export function isStaleSave(
  expected: unknown,
  storedUpdatedAt: string | null
): boolean {
  return expected !== undefined && expected !== storedUpdatedAt;
}

/** 409 for a save over a row somebody changed meanwhile. */
export function staleSaveResponse() {
  return NextResponse.json(
    {
      error:
        'Someone else changed these settings since you opened them. Reload and try again.',
      code: 'STALE',
    },
    { status: 409 }
  );
}
