import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ALL_ALLOWED,
  CHAT_CAPABILITIES,
  CHAT_ROLE_CLASSES,
  GUEST_CAPABILITIES,
  RECOMMENDED_DENIED,
  deniedFromMatrix,
  isDeniable,
  matrixFromRows,
  openPermissionMatrix,
  parseMyPermissions,
  windowOpen,
} from '../permissions';
import { toChannel } from '../types';

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/157_chat_permissions.sql'),
  'utf8'
);

const quoted = (s: string) => [...s.matchAll(/'([^']+)'/g)].map((x) => x[1]);

function checkList(column: string): string[] {
  const m = SQL.match(
    new RegExp(
      `${column}\\s+text\\s+NOT NULL CHECK \\(${column} IN \\(([^)]*)\\)`
    )
  );
  if (!m) throw new Error(`no CHECK for ${column}`);
  return quoted(m[1]);
}

describe('permissions mirror migration 157', () => {
  it('has the CHECK lists for capabilities, classes and guest capabilities', () => {
    expect([...CHAT_CAPABILITIES]).toEqual(checkList('capability'));
    expect([...CHAT_ROLE_CLASSES]).toEqual(checkList('role_class'));
    const guest = SQL.match(
      /chat_role_permissions_guest_caps CHECK \(\s*role_class <> 'bank_guest'\s*OR capability IN \(([^)]*)\)/
    );
    expect(guest).not.toBeNull();
    expect([...GUEST_CAPABILITIES].sort()).toEqual(quoted(guest![1]).sort());
  });

  it('lists the capabilities chat_my_permissions reports', () => {
    const m = SQL.match(/'capabilities',[\s\S]*?unnest\(ARRAY\[([^\]]*)\]/);
    expect(m).not.toBeNull();
    expect(quoted(m![1])).toEqual([...CHAT_CAPABILITIES]);
  });
});

describe('parseMyPermissions', () => {
  it('reads a full answer', () => {
    const caps = Object.fromEntries(CHAT_CAPABILITIES.map((c) => [c, true]));
    const p = parseMyPermissions({
      role_class: 'agent',
      capabilities: { ...caps, mention_everyone: false, edit_own: false },
      edit_window_minutes: 15,
      delete_window_minutes: null,
      windows_apply: true,
      sensitive: { mode: 'block', scope: 'all' },
    });
    expect(p.roleClass).toBe('agent');
    expect(p.can.mention_everyone).toBe(false);
    expect(p.can.edit_own).toBe(false);
    expect(p.can.upload_files).toBe(true);
    expect(p.editWindowMinutes).toBe(15);
    expect(p.deleteWindowMinutes).toBeNull();
    expect(p.windowsApply).toBe(true);
    expect(p.sensitive).toEqual({ mode: 'block', scope: 'all' });
  });

  it('treats anything missing as allowed or off (an older database)', () => {
    const p = parseMyPermissions({
      role_class: 'viewer',
      capabilities: { pin_messages: false },
    });
    expect(p.can.pin_messages).toBe(false);
    expect(
      CHAT_CAPABILITIES.filter((c) => c !== 'pin_messages').every(
        (c) => p.can[c]
      )
    ).toBe(true);
    expect(p.editWindowMinutes).toBeNull();
    expect(p.windowsApply).toBe(false);
    expect(p.sensitive).toEqual({ mode: 'off', scope: 'guests' });
  });

  it('answers ALL_ALLOWED for garbage and ignores unknown values', () => {
    for (const g of [null, undefined, 'x', 42, [], [{ a: 1 }]]) {
      expect(parseMyPermissions(g)).toEqual(ALL_ALLOWED);
    }
    const p = parseMyPermissions({
      role_class: 7,
      capabilities: { upload_files: 'no', send_voice: 0, made_up: false },
      edit_window_minutes: '15',
      delete_window_minutes: -3,
      windows_apply: 'yes',
      sensitive: { mode: 'shout', scope: 'everyone' },
    });
    expect(p).toEqual(ALL_ALLOWED);
  });

  it('never shares the frozen ALL_ALLOWED object', () => {
    const p = parseMyPermissions(null);
    p.can.upload_files = false;
    expect(ALL_ALLOWED.can.upload_files).toBe(true);
  });
});

describe('toChannel reads 157 channel rules', () => {
  it('defaults a missing or unknown rule to everyone', () => {
    const c = toChannel({ id: 'c', posting: 'admins', thread_replies: 'x' });
    expect(c.posting).toBe('admins');
    expect(c.threadReplies).toBe('everyone');
    expect(c.mentionEveryone).toBe('everyone');
  });
});

describe('windowOpen', () => {
  const at = '2026-10-30T10:00:00.000Z';
  const base = Date.parse(at);
  it('is open up to and including the boundary, closed after', () => {
    expect(windowOpen(at, 15, base + 15 * 60_000 - 1)).toBe(true);
    expect(windowOpen(at, 15, base + 15 * 60_000)).toBe(true);
    expect(windowOpen(at, 15, base + 15 * 60_000 + 1)).toBe(false);
    expect(windowOpen(new Date(base), 1, new Date(base + 60_001))).toBe(false);
  });
  it('is always open without a limit or a readable timestamp', () => {
    expect(windowOpen(at, null, base + 1e12)).toBe(true);
    expect(windowOpen('not a date', 5, base)).toBe(true);
  });
});

describe('permission matrix', () => {
  it('round-trips rows → matrix → denied set', () => {
    const rows = [
      { role_class: 'agent', capability: 'mention_everyone' },
      { role_class: 'viewer', capability: 'add_members' },
      { role_class: 'bank_guest', capability: 'send_voice' },
      { role_class: 'nobody', capability: 'send_voice' },
      { role_class: 'agent', capability: 'fly' },
    ];
    const m = matrixFromRows(rows);
    expect(m.agent.mention_everyone).toBe(false);
    expect(m.agent.upload_files).toBe(true);
    expect(deniedFromMatrix(m)).toEqual([
      { role_class: 'agent', capability: 'mention_everyone' },
      { role_class: 'viewer', capability: 'add_members' },
      { role_class: 'bank_guest', capability: 'send_voice' },
    ]);
    expect(matrixFromRows(deniedFromMatrix(m))).toEqual(m);
  });

  it('never emits a guest pair 157 refuses', () => {
    const m = openPermissionMatrix();
    for (const c of CHAT_CAPABILITIES) m.bank_guest[c] = false;
    const guestDenied = deniedFromMatrix(m).map((d) => d.capability);
    expect(guestDenied.sort()).toEqual([...GUEST_CAPABILITIES].sort());
    expect(isDeniable('bank_guest', 'create_team_channel')).toBe(false);
    expect(isDeniable('bank_guest', 'upload_files')).toBe(true);
    expect(isDeniable('viewer', 'create_team_channel')).toBe(true);
  });

  it('has a recommended preset that survives the round trip', () => {
    expect(deniedFromMatrix(matrixFromRows(RECOMMENDED_DENIED))).toEqual([
      ...RECOMMENDED_DENIED,
    ]);
    expect(
      RECOMMENDED_DENIED.every((d) => isDeniable(d.role_class, d.capability))
    ).toBe(true);
    expect(
      RECOMMENDED_DENIED.filter((d) => d.role_class === 'viewer')
    ).toHaveLength(6);
  });
});
