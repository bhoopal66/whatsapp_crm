import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTENTION_REASONS } from './bands';

// The pin precedence lives twice: ATTENTION_REASONS (which reason labels a
// pin, and the inbox's pin order) and insight_pin_attention's c_order in
// migration 153 (which reason a raise may replace). Change one, change both.
const SQL = readFileSync(
  path.join(process.cwd(), 'supabase/migrations/153_insights_v2.sql'),
  'utf8'
);

const quoted = (list: string): string[] =>
  Array.from(list.matchAll(/'([a-z_]+)'/g), (m) => m[1]!);

describe('attention reasons in migration 153', () => {
  it('insight_pin_attention ranks reasons in ATTENTION_REASONS order', () => {
    const m = SQL.match(
      /c_order\s+CONSTANT\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/
    );
    expect(m, 'c_order not found in 153').not.toBeNull();
    expect(quoted(m![1]!)).toEqual([...ATTENTION_REASONS]);
  });

  it('the reason CHECK allows exactly ATTENTION_REASONS', () => {
    const m = SQL.match(/insight_attention_reason IN \(([^)]*)\)/);
    expect(m, 'reason CHECK not found in 153').not.toBeNull();
    // Inside an EXECUTE string the quotes are doubled: ''urgent''.
    const reasons = quoted(m![1]!.replace(/''/g, "'"));
    expect([...reasons].sort()).toEqual([...ATTENTION_REASONS].sort());
  });
});
