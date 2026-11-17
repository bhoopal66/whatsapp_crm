import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WhatsAppChannel } from './channels';
import {
  GroupCreateUnsupportedError,
  GroupsUnsupportedError,
  addParticipants,
  createGroup,
  describeGroupFailure,
  getGroup,
  listGroupsWithStatus,
  updateGroupSetting,
} from './groups';
import { OpenWAError } from './openwa-api';
import * as openwa from './openwa-groups';
import { OpenWAGroupUnsupportedError } from './openwa-groups';
import * as whapi from './whapi-api';

vi.mock('./openwa-groups', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./openwa-groups')>();
  return {
    ...actual,
    createGroup: vi.fn(),
    getGroup: vi.fn(),
    addParticipants: vi.fn(),
    listGroupSummaries: vi.fn(),
    updateSetting: vi.fn(),
  };
});

vi.mock('./whapi-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./whapi-api')>();
  return { ...actual, getGroup: vi.fn() };
});

const GID = '120363025555555555@g.us';
const openwaChannel = {
  id: 'c1',
  provider: 'openwa',
  accessToken: 'key',
  phoneNumberId: 'sess-1',
  isPersonal: false,
} as WhatsAppChannel;
const personalChannel = {
  ...openwaChannel,
  isPersonal: true,
} as WhatsAppChannel;
const metaChannel = {
  id: 'c2',
  provider: 'meta',
  accessToken: 'tok',
} as WhatsAppChannel;
const whapiChannel = {
  id: 'c3',
  provider: 'whapi',
  accessToken: 'tok',
} as WhatsAppChannel;

const mocked = {
  createGroup: vi.mocked(openwa.createGroup),
  getGroup: vi.mocked(openwa.getGroup),
  addParticipants: vi.mocked(openwa.addParticipants),
  listGroupSummaries: vi.mocked(openwa.listGroupSummaries),
  updateSetting: vi.mocked(openwa.updateSetting),
};

const group = (id: string, waIds: string[] = []) =>
  ({
    id,
    name: 'G',
    participants: waIds.map((waId) => ({
      jid: `${waId}@s.whatsapp.net`,
      waId,
      role: 'member',
    })),
  }) as unknown as whapi.WhapiGroup;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gatewayFor refusals', () => {
  it('refuses a Meta number and a personal OpenWA number', async () => {
    expect(() => getGroup({ channel: metaChannel, groupId: GID })).toThrow(
      GroupsUnsupportedError
    );
    expect(() => getGroup({ channel: personalChannel, groupId: GID })).toThrow(
      GroupsUnsupportedError
    );
    await expect(
      createGroup({
        channel: personalChannel,
        name: 'x',
        participants: ['971501234567'],
        deadline: Date.now() + 60_000,
      })
    ).rejects.toBeInstanceOf(GroupsUnsupportedError);
  });
});

describe('createGroup on OpenWA', () => {
  const people = ['971501111111', '971502222222', '971503333333'];

  it('splits the requested people by who the re-read lists', async () => {
    mocked.createGroup.mockResolvedValue({ groupId: GID });
    mocked.getGroup.mockResolvedValue(group(GID, [people[0], people[2]]));
    const out = await createGroup({
      channel: openwaChannel,
      name: 'Deal',
      participants: people,
      deadline: Date.now() + 60_000,
    });
    expect(out.group.id).toBe(GID);
    expect(out.added.map((p) => p.waId)).toEqual([people[0], people[2]]);
    expect(out.refused.map((p) => p.waId)).toEqual([people[1]]);
    expect(out.error).toBeNull();
    expect(mocked.createGroup.mock.calls[0][0]).toMatchObject({
      sessionId: 'sess-1',
      apiKey: 'key',
    });
  });

  it('turns a 501 into GroupCreateUnsupportedError', async () => {
    mocked.createGroup.mockRejectedValue(
      new OpenWAError('not implemented', 501)
    );
    const err = await createGroup({
      channel: openwaChannel,
      name: 'Deal',
      participants: people,
      deadline: Date.now() + 60_000,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GroupCreateUnsupportedError);
    expect(describeGroupFailure(err)).toBe('create_unsupported');
  });
});

describe('addParticipants on OpenWA', () => {
  const four = ['971501111111', '971502222222', '971503333333', '971504444444'];
  const result = (waId: string, status: number) => ({
    id: `${waId}@c.us`,
    success: status === 200,
    status,
  });

  it('sorts per-participant results as classifyAddResults does', async () => {
    mocked.addParticipants.mockResolvedValue([
      result(four[0], 200),
      result(four[1], 409),
      result(four[2], 403),
      result(four[3], 404),
    ]);
    const out = await addParticipants({
      channel: openwaChannel,
      groupId: GID,
      participants: four,
      deadline: Date.now() + 60_000,
    });
    expect(out.added.map((p) => p.waId)).toEqual([four[0], four[1]]);
    expect(out.refused.map((p) => p.waId)).toEqual([four[2]]);
    expect(out.invalid).toEqual([four[3]]);
    expect(out.error).toBeNull();
  });

  it('reports a whole-batch 403 as not_admin and attempts nobody', async () => {
    mocked.addParticipants.mockRejectedValue(new OpenWAError('forbidden', 403));
    const out = await addParticipants({
      channel: openwaChannel,
      groupId: GID,
      participants: four,
      deadline: Date.now() + 60_000,
    });
    expect(out.error).toBe('not_admin');
    expect(out.added).toEqual([]);
    expect(out.notAttempted).toEqual(four);
  });
});

describe('describeGroupFailure for OpenWA', () => {
  const e = (status: number, route?: 'session' | 'message') =>
    new OpenWAError('x', status, { route });
  it.each([
    [e(403), 'not_admin'],
    [e(401), 'channel_disconnected'],
    [e(404, 'message'), 'group_not_found'],
    [e(404, 'session'), 'channel_disconnected'],
    [e(409), 'channel_disconnected'],
    [e(429), 'rate_limited'],
    [e(400), 'invalid_request'],
    [e(501), 'unsupported'],
    [e(503), 'gateway_unavailable'],
    [new OpenWAGroupUnsupportedError('approve_participants'), 'unsupported'],
  ])('maps %#', (err, key) => {
    expect(describeGroupFailure(err)).toBe(key);
  });
});

describe('listGroupsWithStatus on OpenWA', () => {
  const summaries = [{ id: 'g1@g.us' }, { id: 'g2@g.us' }, { id: 'g3@g.us' }];

  it('stops at the deadline and says the list is partial', async () => {
    mocked.listGroupSummaries.mockResolvedValue(summaries as never);
    let t = 0;
    mocked.getGroup.mockImplementation(async (_c, id) => {
      t = 1_000_000; // the clock passes the deadline after the first read
      return group(id);
    });
    const out = await listGroupsWithStatus({
      channel: openwaChannel,
      deadline: 1000,
      now: () => t,
    });
    expect(out.groups.map((g) => g.id)).toEqual(['g1@g.us']);
    expect(out.complete).toBe(false);
  });

  it('skips a group that fails to read and marks the list partial', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocked.listGroupSummaries.mockResolvedValue(summaries as never);
    mocked.getGroup.mockImplementation(async (_c, id) => {
      if (id === 'g2@g.us') throw new OpenWAError('boom', 500);
      return group(id);
    });
    const out = await listGroupsWithStatus({
      channel: openwaChannel,
      deadline: Date.now() + 60_000,
    });
    expect(out.groups.map((g) => g.id)).toEqual(['g1@g.us', 'g3@g.us']);
    expect(out.complete).toBe(false);
  });

  it('is complete when every read succeeds', async () => {
    mocked.listGroupSummaries.mockResolvedValue(summaries as never);
    mocked.getGroup.mockImplementation(async (_c, id) => group(id));
    const out = await listGroupsWithStatus({
      channel: openwaChannel,
      deadline: Date.now() + 60_000,
    });
    expect(out.groups).toHaveLength(3);
    expect(out.complete).toBe(true);
  });
});

describe('updateGroupSetting on OpenWA', () => {
  it('rejects approve_participants as unsupported', async () => {
    const unsupported = new OpenWAGroupUnsupportedError('approve_participants');
    mocked.updateSetting.mockRejectedValue(unsupported);
    const err = await updateGroupSetting({
      channel: openwaChannel,
      groupId: GID,
      setting: 'approve_participants' as whapi.WhapiGroupSetting,
      policy: 'admins' as whapi.WhapiGroupPolicy,
    }).catch((e) => e);
    expect(err).toBe(unsupported);
    expect(describeGroupFailure(err)).toBe('unsupported');
  });
});

describe('a Whapi channel', () => {
  it('still goes to Whapi, not OpenWA', async () => {
    vi.mocked(whapi.getGroup).mockResolvedValue(group(GID));
    await getGroup({ channel: whapiChannel, groupId: GID });
    expect(whapi.getGroup).toHaveBeenCalledOnce();
    expect(mocked.getGroup).not.toHaveBeenCalled();
  });
});
