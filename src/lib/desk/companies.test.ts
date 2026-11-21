import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DESK_CONTACT_ROLES, isDeskContactRole } from './companies';
import { DESK_REFUSALS } from './store';

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/229_desk_customer_contacts.sql'),
  'utf8'
);

describe('company contacts (migration 229)', () => {
  it('has the roles of the SQL CHECK, in order', () => {
    const m = SQL.match(
      /desk_customer_contacts_role_check CHECK \(role IN \(([^)]*)\)\)/
    );
    const roles = [...(m?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
    expect(roles).toEqual([...DESK_CONTACT_ROLES]);
  });

  it('knows every hint migration 229 raises', () => {
    const hints = new Set(
      [...SQL.matchAll(/desk_refuse\('[a-z_]+', '([A-Z_]+)'/g)].map((m) => m[1])
    );
    expect(hints.size).toBeGreaterThan(0);
    for (const h of hints)
      expect(DESK_REFUSALS as readonly string[]).toContain(h);
  });

  it('accepts only a known role', () => {
    expect(isDeskContactRole('pro')).toBe(true);
    expect(isDeskContactRole('director')).toBe(false);
    expect(isDeskContactRole(null)).toBe(false);
  });
});
