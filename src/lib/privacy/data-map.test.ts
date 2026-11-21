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

function functionBody(sql: string, name: string): string {
  const i = sql.indexOf(`FUNCTION public.${name}(`);
  if (i < 0) return '';
  const j = sql.indexOf('$$;', i);
  return j < 0 ? '' : sql.slice(i, j);
}

/**
 * The bodies of the functions migrations register in privacy_extensions
 * (229 onward), which 221's export and 222's erase call: only those
 * bodies count, never the rest of the migration.
 */
export function registeredExtensions(dir = DIR): {
  export: string;
  erase: string;
  missing: string[];
} {
  const files = readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .map((f) => readFileSync(join(dir, f), 'utf8'));
  const all = files.join('\n');
  const out = { export: '', erase: '', missing: [] as string[] };
  for (const sql of files) {
    for (const m of sql.matchAll(
      /INSERT INTO public\.privacy_extensions[^;]*?VALUES\s*\(\s*'[a-z0-9_]+',\s*'([a-z0-9_]+)',\s*(?:'([a-z0-9_]+)'|NULL)/gi
    )) {
      for (const [fn, kind] of [
        [m[1], 'export'],
        [m[2], 'erase'],
      ] as const) {
        if (!fn) continue;
        const body = functionBody(all, fn);
        if (body === '') out.missing.push(fn);
        out[kind] += `${body}\n`;
      }
    }
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

  const ext = registeredExtensions();

  it('finds every function registered in privacy_extensions (229 on)', () => {
    expect(ext.missing).toEqual([]);
    expect(ext.export).toContain('privacy_desk_contacts_export');
  });

  it('exports from every table it marks exported (221 and registered)', () => {
    const sql =
      readFileSync(join(DIR, '221_privacy_export.sql'), 'utf8') + ext.export;
    const missing = Object.entries(PERSONAL)
      .filter(([, e]) => e.exported)
      .map(([t]) => t)
      .filter((t) => !new RegExp(`public\\.${t}\\b`).test(sql));
    expect(missing).toEqual([]);
  });

  it('erases every table it marks delete or anonymise (222 and registered)', () => {
    const sql =
      readFileSync(join(DIR, '222_privacy_erase.sql'), 'utf8') + ext.erase;
    const missing = Object.entries(PERSONAL)
      .filter(([, e]) => e.erase !== 'retain')
      .map(([t]) => t)
      .filter(
        (t) =>
          !new RegExp(`(DELETE FROM|UPDATE) public\\.${t}\\b`).test(sql) &&
          !sql.includes(`('${t}')`) &&
          // erased through an existing function or a cascade
          !(t === 'memory_items' && sql.includes('memory_forget(')) &&
          !(
            t === 'brain_embeddings' &&
            /DELETE FROM public\.brain_items/.test(sql)
          ) &&
          !(t === 'flow_run_events' && sql.includes("('flow_runs')")) &&
          !(
            (t === 'journey_outbox' || t === 'journey_processed_events') &&
            sql.includes("('journey_files')")
          )
      );
    expect(missing).toEqual([]);
  });
});
