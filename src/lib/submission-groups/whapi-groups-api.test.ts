import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { WhapiError } from '@/lib/whatsapp/whapi-api';

const h = vi.hoisted(() => ({
  loadChannels: vi.fn(),
  createGroup: vi.fn(),
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
  h.getGroup.mockResolvedValue({
    id: WA_GROUP,
    participants: [
      { ...identity('971500000000'), role: 'superadmin' },
      { ...identity('971501234567'), role: 'member' },
      { jid: '999@lid', waId: null, role: 'member' },
    ],
  });
});

describe('getParticipants', () => {
  it('reads with a short timeout and lists hidden ids raw', async () => {
    expect(await api().getParticipants('cfg-1', WA_GROUP)).toEqual([
      '971500000000',
      '971501234567',
      '999@lid',
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
    expect(h.removeParticipants).toHaveBeenCalledWith({
      channel: whapi,
      groupId: WA_GROUP,
      participants: ['971501234567'],
    });
    expect(h.leaveGroup).toHaveBeenCalledWith({
      channel: whapi,
      groupId: WA_GROUP,
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
    });
  });

  it('counts a group already gone as closed', async () => {
    h.getGroup.mockRejectedValue(new WhapiError('not found', 404));
    await expect(api().closeGroup('cfg-1', WA_GROUP)).resolves.toBeUndefined();
    expect(h.leaveGroup).not.toHaveBeenCalled();

    h.getGroup.mockResolvedValue({ id: WA_GROUP, participants: [] });
    h.leaveGroup.mockRejectedValue(new WhapiError('not found', 404));
    await expect(api().closeGroup('cfg-1', WA_GROUP)).resolves.toBeUndefined();
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

  it('refuses a number that is not Whapi', async () => {
    await expect(
      api().addParticipant('cfg-meta', WA_GROUP, '971501234567')
    ).rejects.toThrow();
    expect(h.addParticipants).not.toHaveBeenCalled();
  });
});
