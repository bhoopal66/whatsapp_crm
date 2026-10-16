import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { WhapiError } from '@/lib/whatsapp/whapi-api';

const h = vi.hoisted(() => ({
  loadChannels: vi.fn(),
  createGroup: vi.fn(),
  getInviteLink: vi.fn(),
  sendGroupText: vi.fn(),
  getGroup: vi.fn(),
  removeParticipants: vi.fn(),
  leaveGroup: vi.fn(),
}));

vi.mock('@/lib/whatsapp/channels', () => ({ loadChannels: h.loadChannels }));
vi.mock('@/lib/whatsapp/groups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/groups')>()),
  createGroup: h.createGroup,
  getInviteLink: h.getInviteLink,
  sendGroupText: h.sendGroupText,
  getGroup: h.getGroup,
  removeParticipants: h.removeParticipants,
  leaveGroup: h.leaveGroup,
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
