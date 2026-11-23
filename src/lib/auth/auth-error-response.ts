import { NextResponse } from 'next/server';

/** `{ error }`, plus `retryAfterSeconds` and Retry-After when known. */
export function authErrorResponse(
  status: number,
  error: string,
  retryAfterMs?: number
): NextResponse {
  if (retryAfterMs === undefined) {
    return NextResponse.json({ error }, { status });
  }
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return NextResponse.json(
    { error, retryAfterSeconds },
    { status, headers: { 'Retry-After': String(retryAfterSeconds) } }
  );
}
