import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every action the workspace_audit CHECK (092) allows needs a label in
// Settings → Audit log, or the panel shows the raw id. The CHECK is the
// list to read: a trigger writing any other action fails its insert. A
// later migration that redefines the constraint is the one that counts.

const MIGRATIONS = join(process.cwd(), 'supabase/migrations');
const CHECK_RE =
  /CONSTRAINT\s+workspace_audit_action_check\s+CHECK\s*\(\s*action\s+IN\s*\(([^)]*)\)/g;

function checkedActions(): string[] {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let latest: string | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    for (const m of sql.matchAll(CHECK_RE)) latest = m[1];
  }
  return latest ? [...latest.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
}

const en = JSON.parse(
  readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8')
) as {
  Settings: { auditLog: { actions: Record<string, Record<string, unknown>> } };
};

describe('workspace audit action labels', () => {
  it('labels every action the CHECK allows', () => {
    const actions = checkedActions();
    // The regex found 092's list, not nothing.
    expect(actions).toEqual(
      expect.arrayContaining([
        'member_added',
        'role_changed',
        'workspace_renamed',
        'team_chat_disabled',
      ])
    );
    const labels = en.Settings.auditLog.actions.workspace ?? {};
    const missing = actions.filter(
      (a) => typeof labels[a] !== 'string' || !(labels[a] as string).trim()
    );
    expect(missing).toEqual([]);
  });
});
