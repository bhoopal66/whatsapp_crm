import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { WhapiError } from '@/lib/whatsapp/whapi-api';

const h = vi.hoisted(() => ({
  loadChannels: vi.fn(),
  createGroup: vi.fn(),
  findGroupsNamed: vi.fn(),
  getInviteLink: vi.fn(),
  sendGroupText: vi.fn(),
  sendInviteLink: vi.fn(),
  getGroup: vi.fn(),
  removeParticipants: vi.fn(),
  leaveGroup: vi.fn(),
  addParticipants: vi.fn(),
}));

vi.mock('@/lib/whatsapp/channels', () => ({ loadChannels: h.loadChannels }));
vi.mock('@/lib/whatsapp/groups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/groups')>()),
  createGroup: h.createGroup,
  findGroupsNamed: h.findGroupsNamed,
  getInviteLink: h.getInviteLink,
  sendGroupText: h.sendGroupText,
  sendInviteLink: h.sendInviteLink,
  getGroup: h.getGroup,
  removeParticipants: h.removeParticipants,
  leaveGroup: h.leaveGroup,
  addParticipants: h.addParticipants,
}));

import {
  createWhapiGroupsApi,
  SubmissionGroupChannelError,
} from './whapi-groups-api';
import { SubmissionGroupNumberDisconnectedError } from './service';
import {
  closeRemainingText,
  SubmissionGroupCloseIncompleteError,
} from './wa-errors';

const admin = {} as SupabaseClient;
const WA_GROUP = '120363000000000001@g.us';
const whapi = {
  id: 'cfg-1',
  accountId: 'acc-1',
  provider: 'whapi',
  wabaId: '+971 50 000 0000',
  accessToken: 'tok',
};
const api = () => createWhapiGroupsApi(admin, 'acc-1');
const identity = (waId: string) => ({ jid: `${waId}@s.whatsapp.net`, waId });

beforeEach(() => {
  vi.clearAllMocks();
  h.loadChannels.mockResolvedValue([
    whapi,
    { ...whapi, id: 'cfg-meta', provider: 'meta' },
  ]);
  h.createGroup.mockResolvedValue({
    group: { id: WA_GROUP },
    added: [identity('971501234567')],
    refused: [identity('971550000002')],
    notAttempted: [],
    invalid: ['bogus'],
    error: null,
  });
  h.getInviteLink.mockResolvedValue({
    code: 'ABC',
    link: 'https://chat.whatsapp.com/ABC',
  });
  h.removeParticipants.mockResolvedValue({ processed: [], failed: [] });
  h.getGroup.mockResolvedValue({
    id: WA_GROUP,
    participants: [
      { ...identity('971500000000'), role: 'superadmin' },
      { ...identity('971501234567'), role: 'member' },
      { jid: '99999@lid', waId: null, role: 'member' },
    ],
  });
});

describe('findCreatedGroups', () => {
  const since = new Date(1_800_000_000_000);
  const g = (o: object = {}) => ({
    id: WA_GROUP,
    createdAt: 1_800_000_010,
    createdBy: identity('971500000000'),
    terminated: false,
    participants: [
      { ...identity('971500000000'), role: 'superadmin' },
      { ...identity('971501234567'), role: 'member' },
    ],
    ...o,
  });
  const find = () => api().findCreatedGroups('cfg-1', 'Case 1', since);

  it('answers our group with its members, read from the group itself', async () => {
    h.findGroupsNamed.mockResolvedValue([g({ participants: [] })]);
    h.getGroup.mockResolvedValue(g());
    expect(await find()).toEqual([
      {
        waGroupId: WA_GROUP,
        createdAt: new Date(1_800_000_010_000),
        others: ['971501234567'],
      },
    ]);
  });

  it('skips a group made earlier, by someone else, ended, or that we have left', async () => {
    h.findGroupsNamed.mockResolvedValue([g({ createdAt: 1_799_999_999 })]);
    expect(await find()).toEqual([]);
    expect(h.getGroup).not.toHaveBeenCalled();
    h.findGroupsNamed.mockResolvedValue([g()]);
    for (const o of [
      { createdBy: identity('971507777777') },
      { terminated: true },
      { participants: [{ ...identity('971501234567'), role: 'member' }] },
    ]) {
      h.getGroup.mockResolvedValue(g(o));
      expect(await find()).toEqual([]);
    }
  });

  it('throws when the list or the group could not be read', async () => {
    h.findGroupsNamed.mockRejectedValueOnce(new Error('not whole'));
    await expect(find()).rejects.toThrow('not whole');
    h.findGroupsNamed.mockResolvedValue([g()]);
    h.getGroup.mockRejectedValue(new WhapiError('down', 503));
    await expect(find()).rejects.toThrow('down');
  });

  it('gives the create call longer than a paced one', async () => {
    await api().createGroup('cfg-1', ['971501234567'], 'Case 1', 'k');
    expect(h.createGroup).toHaveBeenCalledWith(
      expect.objectContaining({ createTimeoutMs: 40_000 })
    );
  });
});

describe('getParticipants', () => {
  it('reads with a short timeout and lists hidden ids raw', async () => {
    expect(await api().getParticipants('cfg-1', WA_GROUP)).toEqual([
      '971500000000',
      '971501234567',
      '99999@lid',
    ]);
    expect(h.getGroup).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: WA_GROUP, timeoutMs: 8_000 })
    );
  });

  it('makes no gateway call on a disconnected number', async () => {
    h.loadChannels.mockResolvedValue([{ ...whapi, status: 'disconnected' }]);
    expect(await api().getParticipants('cfg-1', WA_GROUP)).toBeNull();
    expect(h.getGroup).not.toHaveBeenCalled();
  });

  it('answers null for a gone group and throws any other failure', async () => {
    h.getGroup.mockRejectedValueOnce(new WhapiError('gone', 404));
    const gone = vi
      .spyOn(WhapiError.prototype, 'isGroupNotFound', 'get')
      .mockReturnValueOnce(true);
    expect(await api().getParticipants('cfg-1', WA_GROUP)).toBeNull();
    gone.mockRestore();
    h.getGroup.mockRejectedValueOnce(new Error('timed out'));
    await expect(api().getParticipants('cfg-1', WA_GROUP)).rejects.toThrow(
      'timed out'
    );
  });
});

describe('getInviteLink', () => {
  it('asks the gateway on the account channel and answers the link', async () => {
    await expect(api().getInviteLink('cfg-1', WA_GROUP)).resolves.toBe(
      'https://chat.whatsapp.com/ABC'
    );
    expect(h.getInviteLink).toHaveBeenCalledWith({
      channel: whapi,
      groupId: WA_GROUP,
    });
  });

  it("refuses another account's number", async () => {
    await expect(
      api().getInviteLink('cfg-other', WA_GROUP)
    ).rejects.toBeInstanceOf(SubmissionGroupChannelError);
    expect(h.getInviteLink).not.toHaveBeenCalled();
  });
});

describe('createGroup', () => {
  it('creates on the account channel, reports who is missing, and fetches the link', async () => {
    const out = await api().createGroup(
      'cfg-1',
      ['971501234567', '971550000002', 'bogus'],
      'Submission S-1',
      'sg-1'
    );
    expect(h.loadChannels).toHaveBeenCalledWith(admin, 'acc-1');
    expect(h.createGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: whapi,
        name: 'Submission S-1',
        participants: ['971501234567', '971550000002', 'bogus'],
        deadline: expect.any(Number),
      })
    );
    expect(out).toEqual({
      waGroupId: WA_GROUP,
      inviteLink: 'https://chat.whatsapp.com/ABC',
      refused: ['971550000002', 'bogus'],
    });
  });

  it('keeps the group when the invite link fails', async () => {
    h.getInviteLink.mockRejectedValue(new WhapiError('no', 403));
    const out = await api().createGroup('cfg-1', ['971501234567'], 'S', 'k');
    expect(out.inviteLink).toBeNull();
    expect(out.waGroupId).toBe(WA_GROUP);
  });

  it('throws when no group was created', async () => {
    h.createGroup.mockResolvedValue({
      group: { id: '' },
      added: [],
      refused: [],
      notAttempted: [],
      invalid: [],
      error: null,
    });
    await expect(
      api().createGroup('cfg-1', ['971501234567'], 'S', 'k')
    ).rejects.toThrow('no group');
  });

  it("refuses another account's or a non-Whapi number", async () => {
    await expect(
      api().createGroup('cfg-other', ['971501234567'], 'S', 'k')
    ).rejects.toBeInstanceOf(SubmissionGroupChannelError);
    await expect(
      api().createGroup('cfg-meta', ['971501234567'], 'S', 'k')
    ).rejects.toThrow('Whapi');
    expect(h.createGroup).not.toHaveBeenCalled();
  });
});

describe('sendInvite', () => {
  it('sends the link from the hosting number', async () => {
    await api().sendInvite('cfg-1', 'CODE1', '971501234567');
    expect(h.sendInviteLink).toHaveBeenCalledWith({
      channel: expect.objectContaining({ id: 'cfg-1' }),
      inviteCode: 'CODE1',
      to: '971501234567',
    });
  });

  it("refuses a number that isn't this account's", async () => {
    await expect(
      api().sendInvite('cfg-other', 'CODE1', '971501234567')
    ).rejects.toBeInstanceOf(SubmissionGroupChannelError);
    expect(h.sendInviteLink).not.toHaveBeenCalled();
  });
});

describe('sendGroupText', () => {
  it('returns the gateway message id', async () => {
    h.sendGroupText.mockResolvedValue({ messageId: 'wamid-1' });
    await expect(api().sendGroupText('cfg-1', WA_GROUP, 'hi')).resolves.toEqual(
      { waMessageId: 'wamid-1' }
    );
    expect(h.sendGroupText).toHaveBeenCalledWith({
      channel: whapi,
      groupId: WA_GROUP,
      text: 'hi',
    });
  });
});

describe('closeGroup', () => {
  it('removes everyone but our number, then leaves', async () => {
    await api().closeGroup('cfg-1', WA_GROUP);
    // Every call is bounded: a hanging number must not eat the cron's run.
    expect(h.getGroup).toHaveBeenCalledWith({
      channel: whapi,
      groupId: WA_GROUP,
      timeoutMs: 8_000,
    });
    expect(h.removeParticipants).toHaveBeenCalledWith({
      channel: whapi,
      groupId: WA_GROUP,
      participants: ['971501234567'],
      timeoutMs: 15_000,
      includeHidden: true,
    });
    expect(h.leaveGroup).toHaveBeenCalledWith({
      channel: whapi,
      groupId: WA_GROUP,
      timeoutMs: 15_000,
    });
    expect(h.removeParticipants.mock.invocationCallOrder[0]).toBeLessThan(
      h.leaveGroup.mock.invocationCallOrder[0]
    );
  });

  it('never removes the creator (our number) even when wabaId is not on file', async () => {
    h.loadChannels.mockResolvedValue([{ ...whapi, wabaId: null }]);
    await api().closeGroup('cfg-1', WA_GROUP);
    expect(h.removeParticipants).toHaveBeenCalledWith({
      channel: { ...whapi, wabaId: null },
      groupId: WA_GROUP,
      participants: ['971501234567'],
      timeoutMs: 15_000,
      includeHidden: true,
    });
  });

  it('asks a disconnected number nothing: its 404 would read as closed', async () => {
    h.loadChannels.mockResolvedValue([{ ...whapi, status: 'disconnected' }]);
    h.getGroup.mockRejectedValue(new WhapiError('Service not found', 404));
    await expect(api().closeGroup('cfg-1', WA_GROUP)).rejects.toThrow(
      SubmissionGroupNumberDisconnectedError
    );
    expect(h.getGroup).not.toHaveBeenCalled();
  });

  it('counts a group already gone as closed', async () => {
    h.getGroup.mockRejectedValue(new WhapiError('not found', 404));
    await expect(api().closeGroup('cfg-1', WA_GROUP)).resolves.toBeUndefined();
    expect(h.leaveGroup).not.toHaveBeenCalled();

    h.getGroup.mockResolvedValue({ id: WA_GROUP, participants: [] });
    h.leaveGroup.mockRejectedValue(new WhapiError('not found', 404));
    await expect(api().closeGroup('cfg-1', WA_GROUP)).resolves.toBeUndefined();
  });

  it('removes the hidden members too, in a call of their own, before leaving', async () => {
    await api().closeGroup('cfg-1', WA_GROUP);
    expect(
      h.removeParticipants.mock.calls.map(([a]) => a.participants)
    ).toEqual([['971501234567'], ['99999@lid']]);
    expect(h.removeParticipants.mock.invocationCallOrder[1]).toBeLessThan(
      h.leaveGroup.mock.invocationCallOrder[0]
    );
  });

  it('stays, and says how many, when WhatsApp keeps someone in', async () => {
    h.removeParticipants.mockResolvedValueOnce({
      processed: [],
      failed: [identity('971501234567')],
    });
    const err = await api()
      .closeGroup('cfg-1', WA_GROUP)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(SubmissionGroupCloseIncompleteError);
    expect((err as Error).message).toBe(closeRemainingText(1));
    expect(h.leaveGroup).not.toHaveBeenCalled();
  });

  it('a refused hidden id counts as still in; a number that is down does not', async () => {
    h.removeParticipants
      .mockResolvedValueOnce({ processed: [], failed: [] })
      .mockRejectedValueOnce(new WhapiError('bad participant', 400));
    await expect(api().closeGroup('cfg-1', WA_GROUP)).rejects.toThrow(
      closeRemainingText(1)
    );
    h.removeParticipants
      .mockResolvedValueOnce({ processed: [], failed: [] })
      .mockRejectedValueOnce(new WhapiError('down', 502));
    await expect(api().closeGroup('cfg-1', WA_GROUP)).rejects.toThrow('down');
    expect(h.leaveGroup).not.toHaveBeenCalled();
  });

  it('never removes a hidden id that may be our own number', async () => {
    h.getGroup.mockResolvedValue({
      id: WA_GROUP,
      participants: [
        { jid: '11111@lid', waId: null, role: 'admin' },
        { jid: '99999@lid', waId: null, role: 'member' },
      ],
    });
    await expect(api().closeGroup('cfg-1', WA_GROUP)).rejects.toThrow(
      closeRemainingText(1)
    );
    expect(h.removeParticipants).not.toHaveBeenCalled();
    expect(h.leaveGroup).not.toHaveBeenCalled();
  });

  it('leaves anyway once the caller has given up on them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.getGroup.mockResolvedValue({
      id: WA_GROUP,
      participants: [
        { jid: '11111@lid', waId: null, role: 'admin' },
        { jid: '99999@lid', waId: null, role: 'member' },
      ],
    });
    await api().closeGroup('cfg-1', WA_GROUP, { leaveAnyway: true });
    expect(h.leaveGroup).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      '[submission-groups] left a group with 1 still in it'
    );
  });

  it('propagates any other failure', async () => {
    h.removeParticipants.mockRejectedValue(new WhapiError('not admin', 403));
    await expect(api().closeGroup('cfg-1', WA_GROUP)).rejects.toThrow(
      'not admin'
    );
    expect(h.leaveGroup).not.toHaveBeenCalled();
  });
});

describe('addParticipant (211)', () => {
  const outcome = (o: Record<string, unknown>) => ({
    added: [],
    refused: [],
    notAttempted: [],
    invalid: [],
    error: null,
    ...o,
  });

  it('adds one number on the group', async () => {
    h.addParticipants.mockResolvedValue(
      outcome({ added: [identity('971501234567')] })
    );
    expect(await api().addParticipant('cfg-1', WA_GROUP, '971501234567')).toBe(
      'added'
    );
    expect(h.addParticipants).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: WA_GROUP,
        participants: ['971501234567'],
      })
    );
  });

  it('answers refused when WhatsApp declines or the number is invalid', async () => {
    h.addParticipants.mockResolvedValue(
      outcome({ refused: [identity('971501234567')] })
    );
    expect(await api().addParticipant('cfg-1', WA_GROUP, '971501234567')).toBe(
      'refused'
    );
    h.addParticipants.mockResolvedValue(outcome({ invalid: ['12'] }));
    expect(await api().addParticipant('cfg-1', WA_GROUP, '12')).toBe('refused');
  });

  it('throws when the call itself failed', async () => {
    h.addParticipants.mockResolvedValue(
      outcome({ notAttempted: ['971501234567'], error: 'unavailable' })
    );
    await expect(
      api().addParticipant('cfg-1', WA_GROUP, '971501234567')
    ).rejects.toThrow('unavailable');
  });

  it('throws when the number was never tried, with no error named', async () => {
    h.addParticipants.mockResolvedValue(
      outcome({ notAttempted: ['971501234567'] })
    );
    await expect(
      api().addParticipant('cfg-1', WA_GROUP, '971501234567')
    ).rejects.toThrow('not attempted');
  });

  it('refuses a number that is not Whapi', async () => {
    await expect(
      api().addParticipant('cfg-meta', WA_GROUP, '971501234567')
    ).rejects.toThrow();
    expect(h.addParticipants).not.toHaveBeenCalled();
  });
});

describe('removeParticipant', () => {
  it('refuses our own number without calling the gateway', async () => {
    await expect(
      api().removeParticipant('cfg-1', WA_GROUP, '971500000000')
    ).rejects.toThrow('our own number');
    expect(h.removeParticipants).not.toHaveBeenCalled();
  });

  it('removes one number through the gateway', async () => {
    h.removeParticipants.mockResolvedValue({ failed: [] });
    await expect(
      api().removeParticipant('cfg-1', WA_GROUP, '971501234567')
    ).resolves.toBeUndefined();
    expect(h.removeParticipants).toHaveBeenCalledWith({
      channel: whapi,
      groupId: WA_GROUP,
      participants: ['971501234567'],
    });
  });

  it('throws when the gateway reports the number as failed', async () => {
    h.removeParticipants.mockResolvedValue({ failed: ['971501234567'] });
    await expect(
      api().removeParticipant('cfg-1', WA_GROUP, '971501234567')
    ).rejects.toThrow('remove participant failed');
  });
});
