import { describe, expect, it, vi } from 'vitest';

import type { WhapiGroup } from '@/lib/whatsapp/whapi-api';

import { persistGroupSnapshot } from './server';
import { fakeSupabase, type FakeDb } from './test-db';

// The create route and the `groups.post` webhook save the same new group
// at the same time. Replacing participants by delete-all-then-insert
// made the second insert collide on (group_id, wa_id), failing the
// create after WhatsApp had made the group, and left the list empty
// between the two calls.

const channel = { id: 'ch-1', accountId: 'acct-1', wabaId: '971500000000' };

const group = (waIds: string[]): WhapiGroup =>
  ({
    id: '120363000000000001@g.us',
    name: 'Team',
    description: null,
    participantsCount: waIds.length,
    participants: waIds.map((waId) => ({
      jid: `${waId}@s.whatsapp.net`,
      waId,
      role: 'member',
    })),
    createdAt: null,
    createdBy: null,
    settings: {},
  }) as unknown as WhapiGroup;

function db(): FakeDb {
  return {
    tables: {
      whatsapp_groups: [],
      whatsapp_group_participants: [],
      contacts: [],
    },
    unique: { whatsapp_group_participants: ['group_id', 'wa_id'] },
  };
}

describe('persistGroupSnapshot tombstones', () => {
  const mark = (account_id: string, channel_id: string) => ({
    account_id,
    channel_id,
    wa_group_id: '120363000000000001@g.us',
  });

  it('writes nothing for a group an admin deleted for good', async () => {
    const d = db();
    d.tables.whatsapp_group_tombstones = [mark('acct-1', 'ch-1')];
    const saved = await persistGroupSnapshot(
      fakeSupabase(d) as never,
      channel,
      group(['971501111111'])
    );
    expect(saved).toBeNull();
    expect(d.tables.whatsapp_groups).toEqual([]);
    expect(d.tables.whatsapp_group_participants).toEqual([]);
  });

  it("ignores another number's or account's tombstone", async () => {
    const d = db();
    d.tables.whatsapp_group_tombstones = [
      mark('acct-1', 'ch-2'),
      mark('acct-2', 'ch-1'),
    ];
    const saved = await persistGroupSnapshot(
      fakeSupabase(d) as never,
      channel,
      group(['971501111111'])
    );
    expect(saved).not.toBeNull();
    expect(d.tables.whatsapp_groups).toHaveLength(1);
  });

  it('writes nothing when the tombstone read fails', async () => {
    const d = db();
    d.errors = { 'whatsapp_group_tombstones:select': { message: 'down' } };
    await expect(
      persistGroupSnapshot(fakeSupabase(d) as never, channel, group([]))
    ).rejects.toEqual({ message: 'down' });
    expect(d.tables.whatsapp_groups).toEqual([]);
  });
});

describe('persistGroupSnapshot participants', () => {
  it('survives two interleaved saves of one group', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = db();
    const admin = fakeSupabase(d) as never;
    const first = ['971501111111', '971502222222'];
    const later = [...first, '971503333333'];
    await expect(
      Promise.all([
        persistGroupSnapshot(admin, channel, group(first)),
        persistGroupSnapshot(admin, channel, group(later)),
      ])
    ).resolves.toHaveLength(2);
    const rows = d.tables.whatsapp_group_participants;
    const ids = rows.map((r) => r.wa_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });

  it('drops someone gone from past the first thousand people', async () => {
    const d = db();
    d.maxRows = 1000;
    const admin = fakeSupabase(d) as never;
    const many = Array.from({ length: 1100 }, (_, i) => `${971500000000 + i}`);
    await persistGroupSnapshot(admin, channel, group(many));
    await persistGroupSnapshot(admin, channel, group(many.slice(0, -1)));
    expect(
      d.tables.whatsapp_group_participants.map((r) => r.wa_id)
    ).not.toContain(many[1099]);
  });

  it('keeps a still-listed row in place and drops only who left', async () => {
    const d = db();
    const admin = fakeSupabase(d) as never;
    const saved = await persistGroupSnapshot(
      admin,
      channel,
      group(['971501111111', '971502222222'])
    );
    for (const r of d.tables.whatsapp_group_participants) {
      r.added_at = '2026-10-01T00:00:00Z';
    }
    await persistGroupSnapshot(
      admin,
      channel,
      group(['971501111111', '971503333333'])
    );
    const rows = d.tables.whatsapp_group_participants;
    expect(rows.map((r) => r.wa_id).sort()).toEqual([
      '971501111111',
      '971503333333',
    ]);
    // Never deleted and re-inserted: a reader in between saw it all along.
    expect(rows.find((r) => r.wa_id === '971501111111')).toMatchObject({
      group_id: saved?.id,
      added_at: '2026-10-01T00:00:00Z',
    });
  });

  it('keeps everyone when a snapshot names nobody', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = db();
    const admin = fakeSupabase(d) as never;
    const full = ['971501111111', '971502222222'];
    const saved = await persistGroupSnapshot(admin, channel, group(full));
    for (const r of d.tables.whatsapp_group_participants) {
      r.added_at = '2026-10-01T00:00:00Z';
    }
    warn.mockClear();

    // OpenWA's answer without a `participants` list.
    const again = await persistGroupSnapshot(admin, channel, {
      ...group([]),
      name: 'Renamed',
    });
    // What else the snapshot says is still stored.
    expect(again).toMatchObject({ id: saved?.id, name: 'Renamed' });
    const rows = () => d.tables.whatsapp_group_participants;
    expect(rows().map((r) => r.wa_id)).toEqual(full);
    expect(d.tables.whatsapp_groups[0].participants_count).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);

    // The next good snapshot re-inserts nobody (219's trigger would make
    // them managers again), and still drops who left.
    await persistGroupSnapshot(admin, channel, group(['971501111111']));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      wa_id: '971501111111',
      added_at: '2026-10-01T00:00:00Z',
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps everyone when nobody listed has a number', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = db();
    const admin = fakeSupabase(d) as never;
    await persistGroupSnapshot(admin, channel, group(['971501111111']));
    await persistGroupSnapshot(admin, channel, {
      ...group([]),
      participantsCount: 1,
      participants: [{ jid: '1@lid', waId: null, role: 'member' }],
    } as unknown as WhapiGroup);
    expect(d.tables.whatsapp_group_participants).toHaveLength(1);
  });

  it('says nothing about a new group that names nobody', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    const d = db();
    const saved = await persistGroupSnapshot(
      fakeSupabase(d) as never,
      channel,
      group([])
    );
    expect(saved).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
