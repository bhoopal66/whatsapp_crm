import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import * as api from '../api';
import { ChatError } from '../errors';
import { toUnreadCount } from '../types';

type Result = { data: unknown; error: unknown };

/** Records rpc calls; answers from `results` in call order. */
function fakeSb(...results: Result[]) {
  const calls: { fn: string; args: unknown }[] = [];
  const sb = {
    rpc: (fn: string, args?: unknown) => {
      calls.push({ fn, args });
      return Promise.resolve(results.shift() ?? { data: null, error: null });
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

const CH = 'c0000000-0000-4000-8000-000000000001';
const U = 'a0000000-0000-4000-8000-00000000000a';

describe('channel administration (091)', () => {
  it('pass the 091 parameter names, null for a kept field', async () => {
    const { sb, calls } = fakeSb();
    await api.updateChannel(sb, { channelId: CH, name: 'sales', topic: '' });
    await api.updateChannel(sb, { channelId: CH, topic: 'Q3' });
    await api.setChannelArchived(sb, CH, true);
    await api.removeMember(sb, { channelId: CH, userId: U });
    await api.setMuted(sb, CH, false);
    expect(calls).toEqual([
      {
        fn: 'chat_update_channel',
        args: { p_channel: CH, p_name: 'sales', p_topic: '' },
      },
      {
        fn: 'chat_update_channel',
        args: { p_channel: CH, p_name: null, p_topic: 'Q3' },
      },
      { fn: 'chat_archive_channel', args: { p_channel: CH, p_archived: true } },
      { fn: 'chat_remove_member', args: { p_channel: CH, p_user: U } },
      { fn: 'chat_set_muted', args: { p_channel: CH, p_muted: false } },
    ]);
  });

  it('throw a ChatError keyed by the wording 091 raises', async () => {
    const cases: [string, string, string, string][] = [
      [
        '42501',
        'chat_update_channel: only channel admins or workspace owner/admin can manage a channel',
        'FORBIDDEN',
        'adminRequired',
      ],
      [
        '42501',
        'chat_archive_channel: not a member of this channel (owner/admin: use chat_admin_read_private to read a private channel)',
        'FORBIDDEN',
        'notChannelMember',
      ],
      [
        '42501',
        'chat_remove_member: bank guests cannot manage channels',
        'FORBIDDEN',
        'guestRestricted',
      ],
      [
        '42501',
        'chat_update_channel: channel is archived',
        'FORBIDDEN',
        'archived',
      ],
      [
        '22023',
        'chat_remove_member: the last admin of a channel cannot be removed',
        'INVALID',
        'lastAdmin',
      ],
      [
        '23505',
        'duplicate key value violates unique constraint "chat_channels_name_uq"',
        'CONFLICT',
        'duplicateName',
      ],
      [
        'CH001',
        'chat_set_muted: internal chat is disabled for this workspace',
        'DISABLED',
        'disabled',
      ],
      [
        'P0002',
        'chat_remove_member: user is not a member of this channel',
        'NOT_FOUND',
        'notFound',
      ],
    ];
    for (const [sqlState, message, code, key] of cases) {
      const { sb } = fakeSb({ data: null, error: { code: sqlState, message } });
      const err = await api
        .removeMember(sb, { channelId: CH, userId: U })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChatError);
      expect(err).toMatchObject({ code, key, sqlState });
    }
  });

  it('read the muted flag of chat_unread_counts', () => {
    expect(
      toUnreadCount({ channel_id: CH, unread: 3, mentions: 1, muted: true })
    ).toEqual({ channelId: CH, unread: 3, mentions: 1, muted: true });
    expect(
      toUnreadCount({ channel_id: CH, unread: 0, mentions: 0 }).muted
    ).toBe(false);
  });
});
