import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NOT_PERSONAL, PERSONAL } from './data-map';

const DIR = join(process.cwd(), 'supabase/migrations');

/** Every table a migration creates (CREATE TABLE [IF NOT EXISTS] [public.]name). */
export function migrationTables(dir = DIR): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
    const sql = readFileSync(join(dir, f), 'utf8').replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi
    ))
      out.add(m[1]!.toLowerCase());
  }
  return out;
}

describe('PDPL data map', () => {
  const tables = migrationTables();

  it('maps every table a migration creates', () => {
    const unmapped = [...tables].filter(
      (t) => !(t in PERSONAL) && !(t in NOT_PERSONAL)
    );
    expect(unmapped, 'add each to PERSONAL or NOT_PERSONAL').toEqual([]);
  });

  it('names no table twice and none that does not exist', () => {
    const both = Object.keys(PERSONAL).filter((t) => t in NOT_PERSONAL);
    expect(both).toEqual([]);
    const ghosts = [
      ...Object.keys(PERSONAL),
      ...Object.keys(NOT_PERSONAL),
    ].filter((t) => !tables.has(t));
    expect(ghosts).toEqual([]);
  });

  it('gives every kept or unexported table its reason', () => {
    for (const [t, e] of Object.entries(PERSONAL)) {
      if (e.erase === 'retain' || !e.exported) expect(e.reason, t).toBeTruthy();
    }
  });

  it('exports from every table it marks exported (migration 221)', () => {
    const sql = readFileSync(join(DIR, '221_privacy_export.sql'), 'utf8');
    const missing = Object.entries(PERSONAL)
      .filter(([, e]) => e.exported)
      .map(([t]) => t)
      .filter((t) => !new RegExp(`public\\.${t}\\b`).test(sql));
    expect(missing).toEqual([]);
  });
});
