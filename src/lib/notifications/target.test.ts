import { describe, expect, it } from 'vitest';

import {
  notificationRow,
  notificationTarget,
  type BellContext,
} from './target';

const CONV = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const ROOM = '33333333-3333-4333-8333-333333333333';
const CH = '44444444-4444-4444-8444-444444444444';
const ROW = '55555555-5555-4555-8555-555555555555';

describe('notificationTarget', () => {
  it.each(['conversation_assigned', 'ai_handoff'])(
    '%s opens the chat',
    (type) => {
      expect(
        notificationTarget(
          { type, conversation_id: CONV, contact_id: CONTACT, meta: {} },
          'agent'
        )
      ).toBe(`/inbox?c=${CONV}`);
      expect(
        notificationTarget({ type, conversation_id: 'nope' }, 'agent')
      ).toBeNull();
    }
  );

  it.each(['task_assigned', 'task_due'])(
    '%s opens the customer page, else the chat, else /calls',
    (type) => {
      expect(
        notificationTarget(
          { type, contact_id: CONTACT, conversation_id: CONV },
          'agent'
        )
      ).toBe(`/contacts/${CONTACT}`);
      expect(
        notificationTarget(
          { type, contact_id: null, conversation_id: CONV },
          'agent'
        )
      ).toBe(`/inbox?c=${CONV}`);
      expect(
        notificationTarget(
          { type, contact_id: 'x', conversation_id: null },
          'agent'
        )
      ).toBe('/calls');
    }
  );

  it.each(['call_missed', 'callback_requested', 'call_outcome_due'])(
    '%s opens the customer page, else the missed-calls view',
    (type) => {
      expect(
        notificationTarget(
          {
            type,
            contact_id: CONTACT,
            conversation_id: CONV,
            meta: { call_id: ROW, contact_id: CONTACT, task_id: ROW },
          },
          'agent'
        )
      ).toBe(`/contacts/${CONTACT}`);
      expect(
        notificationTarget(
          { type, meta: { call_id: ROW, contact_id: CONTACT } },
          'agent'
        )
      ).toBe(`/contacts/${CONTACT}`);
      expect(
        notificationTarget(
          { type, contact_id: null, meta: { call_id: ROW, contact_id: null } },
          'agent'
        )
      ).toBe('/calls');
      expect(notificationTarget({ type, meta: 'junk' }, 'agent')).toBe(
        '/calls'
      );
    }
  );

  it.each(['deal_room_join_request', 'deal_room_update'])(
    '%s opens the deal room',
    (type) => {
      expect(
        notificationTarget(
          { type, meta: { room_id: ROOM, channel_id: CH, event: 'x' } },
          'agent'
        )
      ).toBe(`/chat/rooms/${ROOM}`);
      for (const meta of [
        null,
        'x',
        [],
        { room_id: 'nope' },
        { channel_id: CH },
      ])
        expect(notificationTarget({ type, meta }, 'agent')).toBeNull();
    }
  );

  it.each(['channel_disconnected', 'channel_reconnected'])(
    '%s opens WhatsApp settings for those who can edit settings',
    (type) => {
      expect(notificationTarget({ type }, 'owner')).toBe(
        '/settings?tab=whatsapp'
      );
      expect(notificationTarget({ type }, 'admin')).toBe(
        '/settings?tab=whatsapp'
      );
      expect(notificationTarget({ type }, 'team_leader')).toBeNull();
      expect(notificationTarget({ type }, 'agent')).toBeNull();
      expect(notificationTarget({ type }, null)).toBeNull();
    }
  );

  it.each(['pbx_connection_silent', 'pbx_connection_restored'])(
    '%s opens Phone system settings for those who can edit settings',
    (type) => {
      const meta = { connection_id: CH };
      expect(notificationTarget({ type, meta }, 'owner')).toBe(
        '/settings?tab=phone-system'
      );
      expect(notificationTarget({ type, meta }, 'admin')).toBe(
        '/settings?tab=phone-system'
      );
      expect(notificationTarget({ type, meta }, 'team_leader')).toBeNull();
      expect(notificationTarget({ type, meta }, 'bank_guest')).toBeNull();
      expect(notificationTarget({ type, meta }, null)).toBeNull();
    }
  );

  it('team_activity_alert opens Team activity for leaders and up', () => {
    const type = 'team_activity_alert';
    expect(notificationTarget({ type }, 'admin')).toBe('/team-activity');
    expect(notificationTarget({ type }, 'team_leader')).toBe('/team-activity');
    expect(notificationTarget({ type }, 'agent')).toBeNull();
    expect(notificationTarget({ type }, undefined)).toBeNull();
  });

  it.each(['chat_mention', 'chat_dm', 'chat_thread_reply', 'chat_broadcast'])(
    '%s opens team chat',
    (type) => {
      expect(
        notificationTarget(
          {
            type,
            meta: { channel_id: CH, message_id: ROW, thread_root_id: null },
          },
          'agent'
        )
      ).toBe(`/chat/${CH}`);
      expect(
        notificationTarget({ type, meta: { channel_id: 'x' } }, 'agent')
      ).toBeNull();
    }
  );

  it('meeting_invite opens the meeting', () => {
    expect(
      notificationTarget(
        { type: 'meeting_invite', meta: { meeting_id: ROOM } },
        'agent'
      )
    ).toBe(`/meetings/${ROOM}`);
    for (const meta of [null, 'x', [], { meeting_id: 'nope' }, {}]) {
      expect(
        notificationTarget({ type: 'meeting_invite', meta }, 'agent')
      ).toBeNull();
    }
    expect(
      notificationTarget(
        { type: 'meeting_invite', meta: { meeting_id: ROOM } },
        'bank_guest'
      )
    ).toBeNull();
  });

  it('a bank guest is only sent to team chat', () => {
    expect(
      notificationTarget(
        { type: 'chat_dm', meta: { channel_id: CH } },
        'bank_guest'
      )
    ).toBe(`/chat/${CH}`);
    expect(
      notificationTarget(
        { type: 'deal_room_update', meta: { room_id: ROOM } },
        'bank_guest'
      )
    ).toBe(`/chat/rooms/${ROOM}`);
    expect(
      notificationTarget(
        { type: 'conversation_assigned', conversation_id: CONV },
        'bank_guest'
      )
    ).toBeNull();
    expect(
      notificationTarget(
        { type: 'call_missed', contact_id: CONTACT },
        'bank_guest'
      )
    ).toBeNull();
  });

  it('an unknown type opens nothing, whatever it carries', () => {
    expect(
      notificationTarget(
        { type: 'something_new', conversation_id: CONV, contact_id: CONTACT },
        'owner'
      )
    ).toBeNull();
    expect(notificationTarget({ type: undefined }, 'owner')).toBeNull();
  });
});

describe('notificationRow', () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const G = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const UNLISTED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  // An agent in A (active), an admin in B, a bank guest in G.
  const ctx: BellContext = {
    activeWorkspaceId: A,
    activeRole: 'agent',
    workspaces: [
      { accountId: A, name: 'Taamul Credit', shortName: 'TC', role: 'agent' },
      { accountId: B, name: 'TrafeeqPay', shortName: 'TP', role: 'admin' },
      { accountId: G, name: '', shortName: 'BK', role: 'bank_guest' },
    ],
  };
  const alert = { type: 'channel_disconnected' };

  it('opens an active-workspace row in place, with the active role', () => {
    expect(notificationRow({ ...alert, account_id: A }, ctx)).toEqual({
      href: null,
      otherWorkspace: null,
    });
    expect(
      notificationRow(
        { type: 'conversation_assigned', account_id: A, conversation_id: CONV },
        ctx
      )
    ).toEqual({ href: `/inbox?c=${CONV}`, otherWorkspace: null });
  });

  it("plans another workspace's row with the role held there", () => {
    expect(notificationRow({ ...alert, account_id: B }, ctx)).toEqual({
      href: '/settings?tab=whatsapp',
      otherWorkspace: { accountId: B, name: 'TrafeeqPay' },
    });
    // Admin here, agent there: the settings screen is not theirs there.
    const admin: BellContext = {
      ...ctx,
      activeRole: 'admin',
      workspaces: [
        { accountId: A, name: 'Taamul Credit', shortName: 'TC', role: 'admin' },
        { accountId: B, name: 'TrafeeqPay', shortName: 'TP', role: 'agent' },
      ],
    };
    expect(notificationRow({ ...alert, account_id: A }, admin).href).toBe(
      '/settings?tab=whatsapp'
    );
    expect(notificationRow({ ...alert, account_id: B }, admin)).toEqual({
      href: null,
      otherWorkspace: { accountId: B, name: 'TrafeeqPay' },
    });
  });

  it('sends a bank guest only to team chat in their workspace', () => {
    expect(
      notificationRow(
        {
          type: 'chat_mention',
          account_id: G,
          meta: { channel_id: CH, message_id: ROW },
        },
        ctx
      )
    ).toEqual({
      href: `/chat/${CH}`,
      otherWorkspace: { accountId: G, name: 'BK' },
    });
    expect(
      notificationRow(
        { type: 'conversation_assigned', account_id: G, conversation_id: CONV },
        ctx
      )
    ).toEqual({
      href: null,
      otherWorkspace: { accountId: G, name: 'BK' },
    });
  });

  it('labels an unlisted workspace without a name and no role', () => {
    expect(notificationRow({ ...alert, account_id: UNLISTED }, ctx)).toEqual({
      href: null,
      otherWorkspace: { accountId: UNLISTED, name: null },
    });
    expect(
      notificationRow(
        {
          type: 'conversation_assigned',
          account_id: UNLISTED,
          conversation_id: CONV,
        },
        ctx
      ).href
    ).toBe(`/inbox?c=${CONV}`);
  });

  it('opens in place while either workspace id is unknown', () => {
    const loading: BellContext = { ...ctx, activeWorkspaceId: null };
    expect(notificationRow({ ...alert, account_id: B }, loading)).toEqual({
      href: null,
      otherWorkspace: null,
    });
    expect(notificationRow({ ...alert, account_id: null }, ctx)).toEqual({
      href: null,
      otherWorkspace: null,
    });
  });
});
