import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  REMINDER_KINDS,
  REMINDER_SIDES,
  REMINDER_SUGGESTION_STATUSES,
} from './types';

// The TS lists must equal migration 197's CHECKs: a value the TS side
// writes that the CHECK refuses fails the insert at runtime, and one the
// CHECK allows that the TS side does not know renders as nothing.
const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/197_reminder_suggestions.sql'),
  'utf8'
);

function checkList(column: string): string[] {
  const m = sql.match(new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`));
  if (!m) throw new Error(`no CHECK (${column} IN (...)) in 197`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

describe('reminder suggestion lists match 197', () => {
  it('side', () => {
    expect(checkList('side')).toEqual([...REMINDER_SIDES]);
  });
  it('kind', () => {
    expect(checkList('kind')).toEqual([...REMINDER_KINDS]);
  });
  it('status', () => {
    expect(checkList('status')).toEqual([...REMINDER_SUGGESTION_STATUSES]);
  });
});
