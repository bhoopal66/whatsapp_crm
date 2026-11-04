import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import en from '../../../../messages/en.json';
import { canDeleteChannel, deleteChannel } from '../api';
import {
  channelGone,
  confirmDeletable,
  offersChannelDelete,
} from '../delete-channel';
import { ChatError, toChatError, type ChatErrorKey } from '../errors';
import { chatErrorKey } from '../view';

const CH = '00000000-0000-4000-8000-000000000001';

const client = (rpc: (fn: string, args: unknown) => unknown) =>
  ({
    rpc: async (fn: string, args: unknown) => rpc(fn, args),
  }) as unknown as SupabaseClient;

describe('confirmDeletable', () => {
  it('takes the exact name', () => {
    expect(confirmDeletable('sales-team', 'sales-team')).toBe(true);
  });

  it.each([
    ['a different name', 'sales', 'sales-team'],
    ['another case', 'Sales-Team', 'sales-team'],
    ['a trailing space', 'sales-team ', 'sales-team'],
    ['a leading space', ' sales-team', 'sales-team'],
    ['nothing typed', '', 'sales-team'],
  ])('refuses %s', (_label, typed, name) => {
    expect(confirmDeletable(typed, name)).toBe(false);
  });

  it('keeps a name that really has spaces in it', () => {
    expect(confirmDeletable(' old name ', ' old name ')).toBe(true);
    expect(confirmDeletable('old name', ' old name ')).toBe(false);
  });

  it('never confirms a channel with no name', () => {
    expect(confirmDeletable('', null)).toBe(false);
    expect(confirmDeletable('', '')).toBe(false);
  });
});

describe('offersChannelDelete', () => {
  it('is team and private only', () => {
    expect(offersChannelDelete('team')).toBe(true);
    expect(offersChannelDelete('private')).toBe(true);
    expect(offersChannelDelete('dm')).toBe(false);
    expect(offersChannelDelete('deal_room')).toBe(false);
  });
});

describe('channelGone', () => {
  it('waits for the list, then reads it', () => {
    expect(channelGone(null, CH)).toBe(false);
    expect(channelGone([{ id: CH }], CH)).toBe(false);
    expect(channelGone([{ id: 'other' }], CH)).toBe(true);
    expect(channelGone([], CH)).toBe(true);
  });
});

describe('canDeleteChannel', () => {
  it('asks the database about the one channel', async () => {
    const calls: unknown[] = [];
    const sb = client((fn, args) => {
      calls.push({ fn, args });
      return { data: true, error: null };
    });
    await expect(canDeleteChannel(sb, CH)).resolves.toBe(true);
    expect(calls).toEqual([
      { fn: 'chat_can_delete_channel', args: { p_channel: CH } },
    ]);
  });

  it('is false on a no', async () => {
    const sb = client(() => ({ data: false, error: null }));
    await expect(canDeleteChannel(sb, CH)).resolves.toBe(false);
  });

  // The UI ships before migration 172 is applied.
  it('is false, not an error, while the function does not exist', async () => {
    const sb = client(() => ({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    }));
    await expect(canDeleteChannel(sb, CH)).resolves.toBe(false);
  });

  it('is false when the request itself fails', async () => {
    const sb = client(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(canDeleteChannel(sb, CH)).resolves.toBe(false);
  });
});

describe('deleteChannel', () => {
  it('sends the channel and the typed name', async () => {
    const calls: unknown[] = [];
    const sb = client((fn, args) => {
      calls.push({ fn, args });
      return { data: null, error: null };
    });
    await deleteChannel(sb, { channelId: CH, confirmName: 'sales' });
    expect(calls).toEqual([
      {
        fn: 'chat_delete_channel',
        args: { p_channel: CH, p_confirm_name: 'sales' },
      },
    ]);
  });

  it('throws a ChatError on a refusal', async () => {
    const sb = client(() => ({
      data: null,
      error: {
        code: '42501',
        message: 'chat_delete_channel: you may not delete this channel',
      },
    }));
    await expect(
      deleteChannel(sb, { channelId: CH, confirmName: 'sales' })
    ).rejects.toBeInstanceOf(ChatError);
  });
});

describe('chat_delete_channel refusals', () => {
  const CASES: [string, string, ChatErrorKey][] = [
    [
      '42501',
      'chat_delete_channel: no authenticated user',
      'notWorkspaceMember',
    ],
    ['P0002', 'chat_delete_channel: channel not found', 'notFound'],
    [
      '42501',
      'chat_delete_channel: not a member of this workspace',
      'notWorkspaceMember',
    ],
    [
      'CH001',
      'chat_delete_channel: internal chat is disabled for this workspace',
      'disabled',
    ],
    [
      '42501',
      'chat_delete_channel: you may not delete this channel',
      'channelDeleteDenied',
    ],
    [
      '22023',
      'chat_delete_channel: the confirmation does not match the channel name',
      'channelDeleteMismatch',
    ],
  ];

  it.each(CASES)('%s %s → %s', (code, message, key) => {
    expect(chatErrorKey(toChatError({ code, message }))).toBe(key);
    expect(en.Chat.errors[key as keyof typeof en.Chat.errors]).toBeTruthy();
  });
});
