import { describe, it, expect } from 'vitest';

import { isGroupsWebhook, parseWhapiGroupEvents } from './whapi-group-events';

// Fixtures follow Whapi's published groups webhook examples.
const CH = 'MANTIS-M72HC';
const GID = '120363271212442249@g.us';

const put = (item: Record<string, unknown>) => ({
  groups_participants: [item],
  event: { type: 'groups', event: 'put' },
  channel_id: CH,
});

describe('groups.post', () => {
  it('turns a joined group into an upsert with roles mapped', () => {
    const events = parseWhapiGroupEvents({
      groups: [
        {
          id: GID,
          name: 'Group name! 😃',
          type: 'group',
          timestamp: 1713791253,
          participants: [
            { id: '61371989950', rank: 'member' },
            { id: '919984351847', rank: 'creator' },
          ],
          name_at: 1713791253,
          created_at: 1713791253,
          created_by: '919984351847',
        },
      ],
      event: { type: 'groups', event: 'post' },
      channel_id: CH,
    });
    expect(events).toHaveLength(1);
    const e = events[0];
    if (e.kind !== 'group_upsert') throw new Error('wrong kind');
    expect(e.group.id).toBe(GID);
    expect(e.group.name).toBe('Group name! 😃');
    expect(e.group.participants.map((p) => [p.waId, p.role])).toEqual([
      ['61371989950', 'member'],
      ['919984351847', 'superadmin'],
    ]);
  });

  it('skips a malformed group', () => {
    expect(
      parseWhapiGroupEvents({
        groups: [null, 'x', { id: 'not-a-group' }, {}],
        event: { type: 'groups', event: 'post' },
      })
    ).toEqual([]);
  });
});

describe('groups.put', () => {
  it.each(['add', 'remove', 'promote', 'demote', 'request'] as const)(
    'parses %s',
    (action) => {
      expect(
        parseWhapiGroupEvents(
          put({ group_id: GID, participants: ['61280155346'], action })
        )
      ).toEqual([
        {
          kind: 'participants',
          groupId: GID,
          action,
          waIds: ['61280155346'],
          unresolved: 0,
          performedBy: null,
        },
      ]);
    }
  );

  it('keeps performed_by for a join through the invite link', () => {
    const [e] = parseWhapiGroupEvents(
      put({
        group_id: GID,
        participants: ['61280155346'],
        action: 'add',
        performed_by: 'link',
      })
    );
    expect(e).toMatchObject({ action: 'add', performedBy: 'link' });
  });

  it('normalises ids, de-duplicates and counts the unresolvable', () => {
    const [e] = parseWhapiGroupEvents(
      put({
        group_id: GID,
        participants: ['61280155346@s.whatsapp.net', '61280155346', '99@lid'],
        action: 'add',
      })
    );
    expect(e).toMatchObject({ waIds: ['61280155346'], unresolved: 1 });
  });

  it('ignores an unknown action, a bad group id and a non-list', () => {
    expect(
      parseWhapiGroupEvents(
        put({ group_id: GID, participants: ['61280155346'], action: 'mute' })
      )
    ).toEqual([]);
    expect(
      parseWhapiGroupEvents(
        put({ group_id: '123', participants: ['61280155346'], action: 'add' })
      )
    ).toEqual([]);
    expect(
      parseWhapiGroupEvents(
        put({ group_id: GID, participants: 'x', action: 'add' })
      )
    ).toEqual([]);
  });
});

describe('groups.patch', () => {
  const participants = [
    { id: '61371989950', rank: 'member' },
    { id: '919984351847', rank: 'creator' },
  ];
  const patch = (before: object, after: object) => ({
    groups_updates: [{ before_update: before, after_update: after }],
    event: { type: 'groups', event: 'patch' },
    channel_id: CH,
  });
  const base = {
    id: '120363498775936551@g.us',
    type: 'group',
    participants,
    created_at: 1743410397,
    created_by: '919984351847',
  };

  it('reports a rename', () => {
    expect(
      parseWhapiGroupEvents(
        patch(
          { ...base, name: 'Our journey ⛰️', adminAddMemberMode: true },
          { ...base, name: 'Good trip ⛰️🏔️', adminAddMemberMode: true }
        )
      )
    ).toEqual([
      {
        kind: 'group_update',
        groupId: base.id,
        changes: { name: 'Good trip ⛰️🏔️' },
      },
    ]);
  });

  it('reports a join-approval change as a setting', () => {
    const [e] = parseWhapiGroupEvents(
      patch(
        { ...base, name: 'Our journey', joinApprovalMode: true },
        { ...base, name: 'Our journey', joinApprovalMode: false }
      )
    );
    expect(e).toMatchObject({
      changes: { settings: { approve_participants: 'anyone' } },
    });
  });

  it('drops a picture-only change (nothing the CRM tracks changed)', () => {
    expect(
      parseWhapiGroupEvents(
        patch(
          { ...base, name: 'Our journey', chat_pic: 'changed' },
          {
            ...base,
            name: 'Our journey',
            chat_pic: 'https://pps.example/a.jpg',
          }
        )
      )
    ).toEqual([]);
  });

  it('skips an item with no after snapshot', () => {
    expect(parseWhapiGroupEvents(patch({ ...base, name: 'a' }, {}))).toEqual(
      []
    );
  });
});

describe('robustness', () => {
  it('returns nothing for non-group bodies and garbage', () => {
    expect(parseWhapiGroupEvents(null)).toEqual([]);
    expect(parseWhapiGroupEvents('x')).toEqual([]);
    expect(parseWhapiGroupEvents({})).toEqual([]);
    expect(
      parseWhapiGroupEvents({
        messages: [{ id: 'm' }],
        event: { type: 'messages', event: 'post' },
      })
    ).toEqual([]);
  });

  it('identifies groups callbacks', () => {
    expect(isGroupsWebhook({ event: { type: 'groups', event: 'put' } })).toBe(
      true
    );
    expect(isGroupsWebhook({ event: { type: 'messages' } })).toBe(false);
    expect(isGroupsWebhook(undefined)).toBe(false);
  });
});
