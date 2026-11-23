// ============================================================
// The answer when the database refuses or fails an internal route: the
// real error goes to the log, the caller gets the generic message.
// PostgREST's text names tables, columns and constraints.
// ============================================================

import { NextResponse } from 'next/server';

/** Logs `err` under `where` and answers the generic 500. */
export function serverErrorResponse(where: string, err: unknown): NextResponse {
  console.error(`[${where}] failed:`, err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
