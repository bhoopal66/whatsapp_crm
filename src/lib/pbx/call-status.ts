// Call statuses and the missed-call rule (module 015, migration 089).
// No imports: client components (the customer timeline, the call card,
// the inbox composer via ./timeline) use these, and ./calls, which
// re-exports them, pulls in next/server.

export const CALL_STATUSES = [
  'ringing',
  'in_progress',
  'answered',
  'no_answer',
  'busy',
  'voicemail',
  'abandoned',
  'failed',
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];
export type CallDirection = 'inbound' | 'outbound' | 'internal';

/** An inbound call that ended like this is missed (as the processor's tasks). */
export const MISSED_STATUSES: readonly CallStatus[] = [
  'no_answer',
  'busy',
  'abandoned',
  'voicemail',
];

export function isMissedCall(c: { direction: string; status: string }) {
  return (
    c.direction === 'inbound' &&
    MISSED_STATUSES.includes(c.status as CallStatus)
  );
}
