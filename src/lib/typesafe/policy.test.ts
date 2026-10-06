import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECK_NAMES } from './config';
import {
  DEFAULT_THRESHOLDS,
  THRESHOLD_BOUNDS,
  validateThresholds,
} from './policy';

// ts_validate_thresholds (migration 063) mirrors THRESHOLD_BOUNDS: SQL
// validates at proposal and approval, TypeScript when a policy loads.
// If the two drift, a policy the database accepted is refused at load
// (or the reverse) — so they are compared here, literally.
const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/063_typesafe_decision_layer.sql'),
  'utf8'
);

function sqlBounds(check: string): Record<string, [number, number, boolean]> {
  const m = SQL.match(
    new RegExp(`WHEN '${check}' THEN '(\\{[^']*\\})'::jsonb`)
  );
  if (!m) throw new Error(`no ts_threshold_bounds branch for ${check}`);
  return JSON.parse(m[1]!);
}

describe('threshold bounds: TypeScript and SQL agree', () => {
  it.each(CHECK_NAMES)('%s', (check) => {
    const ts = THRESHOLD_BOUNDS[check] as Record<
      string,
      { min: number; max: number; integer?: boolean }
    >;
    const sql = sqlBounds(check);
    expect(Object.keys(sql).sort()).toEqual(Object.keys(ts).sort());
    for (const [key, b] of Object.entries(ts)) {
      expect(sql[key], key).toEqual([b.min, b.max, b.integer ?? false]);
    }
  });

  it('the defaults are valid under the bounds', () => {
    for (const check of CHECK_NAMES) {
      expect(() =>
        validateThresholds(check, DEFAULT_THRESHOLDS[check])
      ).not.toThrow();
    }
  });
});
