import type { RowOutcome } from './dispatch';

/** What POST /api/push/test answers about the caller's own test row. */
export type PushTestOutcome =
  'sent' | 'held' | 'no_device' | 'failed' | 'queued';

export function testOutcome(row: RowOutcome): PushTestOutcome {
  if (row === 'skipped_quiet') return 'held';
  return row === 'skipped' ? 'no_device' : row;
}
