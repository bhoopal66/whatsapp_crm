import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isLocale,
  localeDir,
  LOCALES,
  readLocaleCookie,
  resolveLocale,
  workspaceDefaultLocale,
} from './locales';

describe('locales', () => {
  it('matches the CHECK and the RPC list of migration 259', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/259_preferred_language.sql'),
      'utf8'
    );
    const lists = [...sql.matchAll(/IN \(((?:'[a-z]+'(?:, )?)+)\)/g)].map((m) =>
      m[1]
        .split(',')
        .map((s) => s.trim().replace(/'/g, ''))
        .sort()
    );
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const list of lists) expect(list).toEqual([...LOCALES].sort());
  });

  it('prefers the cookie, then the workspace default, then English', () => {
    expect(resolveLocale('ar', 'ko')).toBe('ar');
    expect(resolveLocale(undefined, 'ko')).toBe('ko');
    expect(resolveLocale(null, undefined)).toBe('en');
    // Anything unsupported is ignored at each step.
    expect(resolveLocale('../../etc/passwd', 'ko')).toBe('ko');
    expect(resolveLocale('fr', 'de')).toBe('en');
    expect(workspaceDefaultLocale('')).toBe('en');
  });

  it('only Arabic is right to left', () => {
    expect(localeDir('ar')).toBe('rtl');
    expect(localeDir('en')).toBe('ltr');
    expect(localeDir('ko')).toBe('ltr');
    expect(localeDir('xx')).toBe('ltr');
  });

  it('reads the cookie out of a cookie header', () => {
    expect(readLocaleCookie('a=1; NEXT_LOCALE=ar; b=2')).toBe('ar');
    expect(readLocaleCookie('NEXT_LOCALE=fr')).toBeNull();
    expect(readLocaleCookie('XNEXT_LOCALE=ar')).toBeNull();
    expect(readLocaleCookie('')).toBeNull();
    expect(isLocale('ko')).toBe(true);
    expect(isLocale(1)).toBe(false);
  });
});
