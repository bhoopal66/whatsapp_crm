import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenWAError } from './openwa-api';
import {
  OpenWAGroupUnsupportedError,
  addParticipants,
  approveJoinRequest,
  classifyAddResults,
  createGroup,
  fromOpenWAParticipantId,
  fromOpenWASettings,
  getGroup,
  getInviteCode,
  getJoinInfo,
  listGroupSummaries,
  listJoinRequests,
  rejectJoinRequest,
  removeParticipants,
  setPicture,
  toOpenWAParticipantId,
  toOpenWASettings,
  updateSetting,
} from './openwa-groups';

const creds = { apiKey: 'key-1', sessionId: 'sess-1' };
const GID = '120363012345678901@g.us';
const fetchMock = vi.fn();

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return {
    url: String(url),
    init: init as RequestInit,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to fail');
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('OPENWA_URL', 'http://openwa.test:2785/');
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('participant ids', () => {
  it('maps a waId to an OpenWA id', () => {
    expect(toOpenWAParticipantId('971558233531')).toBe('971558233531@c.us');
    expect(toOpenWAParticipantId('123456789012@lid')).toBe('123456789012@lid');
    expect(toOpenWAParticipantId('971558233531@c.us')).toBeNull();
    expect(toOpenWAParticipantId('+971 55')).toBeNull();
    expect(toOpenWAParticipantId('')).toBeNull();
  });

  it('maps an OpenWA id back to an identity', () => {
    expect(fromOpenWAParticipantId('971558233531@c.us')).toEqual({
      jid: '971558233531@c.us',
      waId: '971558233531',
    });
    expect(fromOpenWAParticipantId('123456789012@lid')).toEqual({
      jid: '123456789012@lid',
      waId: '123456789012@lid',
    });
    expect(fromOpenWAParticipantId(GID)).toEqual({ jid: GID, waId: null });
  });
});

describe('settings', () => {
  it('maps OpenWA flags to policies', () => {
    expect(
      fromOpenWASettings({
        announce: true,
        locked: false,
        memberAddMode: 'all',
      })
    ).toEqual({
      send_messages: 'admins',
      edit_group_info: 'anyone',
      add_participants: 'anyone',
      approve_participants: null,
    });
    expect(
      fromOpenWASettings({
        announce: false,
        locked: true,
        memberAddMode: 'admins',
      })
    ).toEqual({
      send_messages: 'anyone',
      edit_group_info: 'admins',
      add_participants: 'admins',
      approve_participants: null,
    });
    expect(fromOpenWASettings({})).toEqual({
      send_messages: null,
      edit_group_info: null,
      add_participants: null,
      approve_participants: null,
    });
  });

  it('builds the PUT body and refuses join approval', async () => {
    expect(toOpenWASettings('send_messages', 'admins')).toEqual({
      announce: true,
    });
    expect(toOpenWASettings('edit_group_info', 'anyone')).toEqual({
      locked: false,
    });
    expect(toOpenWASettings('add_participants', 'anyone')).toEqual({
      memberAddMode: 'all',
    });
    expect(() => toOpenWASettings('approve_participants', 'admins')).toThrow(
      OpenWAGroupUnsupportedError
    );

    fetchMock.mockResolvedValueOnce(json(200, { success: true }));
    await updateSetting(creds, GID, 'add_participants', 'admins');
    const call = lastCall();
    expect(call.init.method).toBe('PUT');
    expect(call.url).toBe(
      `http://openwa.test:2785/api/sessions/sess-1/groups/${encodeURIComponent(GID)}/settings`
    );
    expect(call.body).toEqual({ memberAddMode: 'admins' });
  });
});

describe('getGroup', () => {
  it('maps roles, createdAt, owner and settings', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        id: GID,
        name: 'Deal 42',
        description: 'Docs',
        owner: '971500000001@c.us',
        createdAt: 1_700_000_000,
        participants: [
          {
            id: '971500000001@c.us',
            number: '971500000001',
            isAdmin: true,
            isSuperAdmin: true,
          },
          {
            id: '971500000002@c.us',
            number: '971500000002',
            isAdmin: true,
            isSuperAdmin: false,
          },
          {
            id: '123456789012@lid',
            number: '',
            isAdmin: false,
            isSuperAdmin: false,
          },
        ],
        announce: true,
        locked: true,
        memberAddMode: 'admins',
      })
    );
    const g = await getGroup(creds, GID);
    expect(g).toEqual({
      id: GID,
      name: 'Deal 42',
      description: 'Docs',
      participantsCount: 3,
      participants: [
        { jid: '971500000001@c.us', waId: '971500000001', role: 'superadmin' },
        { jid: '971500000002@c.us', waId: '971500000002', role: 'admin' },
        { jid: '123456789012@lid', waId: '123456789012@lid', role: 'member' },
      ],
      createdAt: 1_700_000_000,
      createdBy: { jid: '971500000001@c.us', waId: '971500000001' },
      iconUrl: null,
      inviteCode: null,
      settings: {
        send_messages: 'admins',
        edit_group_info: 'admins',
        add_participants: 'admins',
        approve_participants: null,
      },
      suspended: false,
      terminated: false,
    });
    expect(lastCall().init.method).toBe('GET');
  });

  it('leaves createdAt and createdBy null when absent', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { id: GID, name: 'x', participants: [] })
    );
    const g = await getGroup(creds, GID);
    expect(g.createdAt).toBeNull();
    expect(g.createdBy).toBeNull();
    expect(g.participantsCount).toBe(0);
  });
});

describe('routes on errors', () => {
  it('a group-path 404 is a message-route error, not a removed session', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { message: 'Group not found' }));
    const e = await caught(getGroup(creds, GID));
    expect(e).toBeInstanceOf(OpenWAError);
    const err = e as OpenWAError;
    expect(err.status).toBe(404);
    expect(err.route).toBe('message');
    expect(err.isSessionNotFound).toBe(false);
  });

  it("create's 404 is a session-route error", async () => {
    fetchMock.mockResolvedValueOnce(
      json(404, { message: 'Session not found' })
    );
    const err = (await caught(
      createGroup(creds, { name: 'x', participants: ['971500000001'] })
    )) as OpenWAError;
    expect(err).toBeInstanceOf(OpenWAError);
    expect(err.route).toBe('session');
    expect(err.isSessionNotFound).toBe(true);
  });

  it('create 501 propagates with status 501', async () => {
    fetchMock.mockResolvedValueOnce(json(501, { message: 'Not implemented' }));
    const err = (await caught(
      createGroup(creds, { name: 'x', participants: ['971500000001'] })
    )) as OpenWAError;
    expect(err).toBeInstanceOf(OpenWAError);
    expect(err.status).toBe(501);
  });
});

describe('createGroup and list', () => {
  it('posts c.us ids and returns the new id', async () => {
    fetchMock.mockResolvedValueOnce(
      json(201, { id: GID, name: 'Deal', participantsCount: 2 })
    );
    await expect(
      createGroup(creds, {
        name: 'Deal',
        participants: ['971500000001', '123456789012@lid'],
      })
    ).resolves.toEqual({ groupId: GID });
    const call = lastCall();
    expect(call.url).toBe('http://openwa.test:2785/api/sessions/sess-1/groups');
    expect(call.init.method).toBe('POST');
    expect(call.body).toEqual({
      name: 'Deal',
      participants: ['971500000001@c.us', '123456789012@lid'],
    });
  });

  it('keeps only @g.us ids in the summary list', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, [
        { id: GID, name: 'A' },
        { id: '971500000001@c.us', name: 'not a group' },
        { id: '120363000000000002@g.us', name: 'B', linkedParentJID: 'x' },
      ])
    );
    await expect(listGroupSummaries(creds)).resolves.toEqual([
      { id: GID, name: 'A' },
      { id: '120363000000000002@g.us', name: 'B' },
    ]);
  });
});

describe('participants', () => {
  it('classifies add results', () => {
    const requested = [
      '971500000001',
      '971500000002',
      '971500000003',
      '971500000004',
      '971500000005',
      '971500000006',
      'bad',
    ];
    const out = classifyAddResults(requested, [
      { id: '971500000001@c.us', success: true, status: 200 },
      { id: '971500000002@c.us', success: false, status: 409 },
      { id: '971500000003@c.us', success: false, status: 404 },
      { id: '971500000004@c.us', success: false, status: 403 },
      {
        id: '971500000005@c.us',
        success: true,
        status: 403,
        message: 'invite sent',
      },
      { id: '971500000006@c.us', success: false, status: 408 },
    ]);
    expect(out.added.map((i) => i.waId)).toEqual([
      '971500000001',
      '971500000002',
    ]);
    expect(out.refused.map((i) => i.waId)).toEqual([
      '971500000004',
      '971500000005',
      '971500000006',
    ]);
    expect(out.invalid).toEqual(['971500000003', 'bad']);
  });

  it('DELETE sends the participants as a JSON body', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        results: [{ id: '971500000001@c.us', success: true, status: 200 }],
      })
    );
    const res = await removeParticipants(creds, GID, ['971500000001']);
    const call = lastCall();
    expect(call.init.method).toBe('DELETE');
    expect(call.url).toMatch(/\/groups\/[^/]+\/participants$/);
    expect(call.body).toEqual({ participants: ['971500000001@c.us'] });
    expect((call.init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    );
    expect(res).toEqual([
      { id: '971500000001@c.us', success: true, status: 200 },
    ]);
  });

  it('add passes the raw results through', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        results: [
          {
            id: '971500000001@c.us',
            success: false,
            status: 403,
            message: 'm',
          },
        ],
      })
    );
    await expect(
      addParticipants(creds, GID, ['971500000001'])
    ).resolves.toEqual([
      { id: '971500000001@c.us', success: false, status: 403, message: 'm' },
    ]);
    expect(lastCall().init.method).toBe('POST');
  });
});

describe('join requests', () => {
  it('approve and reject send exactly one id', async () => {
    fetchMock.mockImplementation(async () => json(200, { success: true }));
    await approveJoinRequest(creds, GID, '971500000001');
    let call = lastCall();
    expect(call.url).toMatch(/\/membership-requests\/approve$/);
    expect(call.body).toEqual({ participants: ['971500000001@c.us'] });
    await rejectJoinRequest(creds, GID, '123456789012@lid');
    call = lastCall();
    expect(call.url).toMatch(/\/membership-requests\/reject$/);
    expect(call.body).toEqual({ participants: ['123456789012@lid'] });
  });

  it('refuses an empty id before any request', async () => {
    await expect(approveJoinRequest(creds, GID, '')).rejects.toBeInstanceOf(
      OpenWAError
    );
    await expect(rejectJoinRequest(creds, GID, '')).rejects.toBeInstanceOf(
      OpenWAError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists requests as identities', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, [
        {
          participantId: '971500000001@c.us',
          method: 'invite_link',
          requestedAt: 1_700_000_000,
        },
      ])
    );
    await expect(listJoinRequests(creds, GID)).resolves.toEqual([
      {
        jid: '971500000001@c.us',
        waId: '971500000001',
        method: 'invite_link',
        requestedAt: 1_700_000_000,
      },
    ]);
  });
});

describe('invites and pictures', () => {
  it('setPicture strips a data-URI prefix', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { success: true }));
    await setPicture(creds, GID, {
      base64: 'data:image/jpeg;base64,QUJD',
      mimetype: 'image/jpeg',
    });
    const call = lastCall();
    expect(call.init.method).toBe('PUT');
    expect(call.body).toEqual({ base64: 'QUJD', mimetype: 'image/jpeg' });
  });

  it('maps the invite code', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        inviteCode: 'AbC123',
        inviteLink: 'https://chat.whatsapp.com/AbC123',
      })
    );
    await expect(getInviteCode(creds, GID)).resolves.toEqual({
      code: 'AbC123',
      link: 'https://chat.whatsapp.com/AbC123',
    });
  });

  it('parses join info defensively', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        gid: { _serialized: GID },
        subject: 'Deal',
        size: 4,
        creation: 1_700_000_000,
      })
    );
    await expect(getJoinInfo(creds, 'AbC 1')).resolves.toEqual({
      id: GID,
      name: 'Deal',
      participantsCount: 4,
      createdAt: 1_700_000_000,
    });
    expect(lastCall().url).toMatch(/\/groups\/join-info\?code=AbC%201$/);
  });
});
