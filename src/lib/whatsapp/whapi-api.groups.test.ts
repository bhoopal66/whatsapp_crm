import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WhapiError,
  addGroupParticipants,
  approveGroupJoinRequest,
  createGroup,
  getGroup,
  getGroupIcon,
  listAllGroups,
  listGroupJoinRequests,
  parseWhapiGroup,
  parseWhapiIdentity,
  setGroupIcon,
  updateGroupSetting,
} from './whapi-api';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const GID = '120363025555555555@g.us';

function call(i = 0) {
  const [url, init] = fetchMock.mock.calls[i];
  return {
    url: new URL(url as string),
    method: (init as RequestInit).method,
    body: (init as RequestInit).body
      ? JSON.parse((init as RequestInit).body as string)
      : undefined,
  };
}

describe('parseWhapiIdentity', () => {
  it('reads a chat id string, the extended form, and a bare lid', () => {
    expect(parseWhapiIdentity('971501234567@s.whatsapp.net')).toEqual({
      jid: '971501234567@s.whatsapp.net',
      waId: '971501234567',
    });
    expect(
      parseWhapiIdentity({ id: '1234567890123@lid', phone: '971501234567' })
    ).toEqual({ jid: '1234567890123@lid', waId: '971501234567' });
    expect(parseWhapiIdentity('1234567890123@lid')).toEqual({
      jid: '1234567890123@lid',
      waId: null,
    });
    expect(parseWhapiIdentity(null)).toBeNull();
    expect(parseWhapiIdentity({ phone: '971501234567' })).toBeNull();
  });
});

describe('parseWhapiGroup', () => {
  it('maps ranks, settings flags and counts into the neutral shape', () => {
    const g = parseWhapiGroup({
      id: GID,
      type: 'group',
      name: 'Sales',
      participants: [
        { id: '971500000001', rank: 'creator' },
        { id: '971500000002@s.whatsapp.net', rank: 'admin' },
        { id: { id: '55@lid', phone: '971500000003' }, rank: 'member' },
        { rank: 'member' },
      ],
      participants_count: 3,
      announcements: true,
      restricted: false,
      chat_pic: 'https://pps.whatsapp.net/x.jpg',
    });
    expect(g).toMatchObject({
      id: GID,
      name: 'Sales',
      participantsCount: 3,
      iconUrl: 'https://pps.whatsapp.net/x.jpg',
      settings: {
        send_messages: 'admins',
        edit_group_info: 'anyone',
        approve_participants: null,
        add_participants: null,
      },
    });
    expect(g?.participants.map((p) => [p.waId, p.role])).toEqual([
      ['971500000001', 'superadmin'],
      ['971500000002', 'admin'],
      ['971500000003', 'member'],
    ]);
  });

  it('rejects a payload without a group id', () => {
    expect(parseWhapiGroup({ id: '971500000001@s.whatsapp.net' })).toBeNull();
    expect(parseWhapiGroup('nope')).toBeNull();
  });
});

describe('createGroup', () => {
  it('posts subject + bare-digit participants and splits refused people out', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        id: GID,
        type: 'group',
        name: 'Deal',
        participants: [
          { id: '971500000009', rank: 'creator' },
          { id: '971500000001', rank: 'member' },
          { id: '971500000002', rank: 'member' },
        ],
        unprocessed_participants: ['971500000002@s.whatsapp.net'],
      })
    );
    const res = await createGroup({
      token: 't',
      subject: 'Deal',
      participants: ['+971 50 000 0001', '971500000002'],
    });
    const c = call();
    expect(c.url.pathname).toBe('/groups');
    expect(c.method).toBe('POST');
    expect(c.body).toEqual({
      subject: 'Deal',
      participants: ['971500000001', '971500000002'],
    });
    expect(res.group.id).toBe(GID);
    expect(res.failed.map((f) => f.waId)).toEqual(['971500000002']);
    expect(res.processed.map((p) => p.waId)).toEqual([
      '971500000009',
      '971500000001',
    ]);
  });

  it('refuses an empty participant list before calling the gateway', async () => {
    await expect(
      createGroup({ token: 't', subject: 'x', participants: [' '] })
    ).rejects.toBeInstanceOf(WhapiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('listAllGroups', () => {
  it('walks pages until a short page', async () => {
    const page = (n: number, start: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `1203630255555${String(start + i).padStart(5, '0')}@g.us`,
        name: `g${start + i}`,
        participants: [],
      }));
    fetchMock
      .mockResolvedValueOnce(json({ groups: page(2, 0), total: 3 }))
      .mockResolvedValueOnce(json({ groups: page(1, 2), total: 3 }));
    const all = await listAllGroups({ token: 't', pageSize: 2 });
    expect(all.map((g) => g.name)).toEqual(['g0', 'g1', 'g2']);
    expect(call(0).url.searchParams.get('offset')).toBe('0');
    expect(call(1).url.searchParams.get('offset')).toBe('2');
    expect(call(1).url.searchParams.get('count')).toBe('2');
  });

  it('stops at maxGroups', async () => {
    fetchMock.mockImplementation(async () =>
      json({
        groups: [
          { id: '120363025555500001@g.us', name: 'a' },
          { id: '120363025555500002@g.us', name: 'b' },
        ],
      })
    );
    const all = await listAllGroups({ token: 't', pageSize: 2, maxGroups: 3 });
    expect(all).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('group calls', () => {
  it('encodes the group id in the path and sends one setting per PATCH', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true }));
    await updateGroupSetting({
      token: 't',
      groupId: GID,
      setting: 'send_messages',
      policy: 'admins',
    });
    const c = call();
    expect(c.url.pathname).toBe(`/groups/${encodeURIComponent(GID)}`);
    expect(c.method).toBe('PATCH');
    expect(c.body).toEqual({ setting: 'send_messages', policy: 'admins' });
  });

  it('rejects a non-group id without a request', async () => {
    await expect(
      getGroup({ token: 't', groupId: '971500000001@s.whatsapp.net' })
    ).rejects.toThrow(/group id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads processed/failed from an add', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        success: true,
        processed: ['971500000001@s.whatsapp.net'],
        failed: [{ id: '9@lid', phone: '971500000002' }],
      })
    );
    const res = await addGroupParticipants({
      token: 't',
      groupId: GID,
      participants: ['971500000001', '971500000002'],
    });
    expect(res.processed.map((p) => p.waId)).toEqual(['971500000001']);
    expect(res.failed.map((p) => p.waId)).toEqual(['971500000002']);
  });

  it('maps a 403 to isNotGroupAdmin and a 409 to isAlreadyParticipant', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: 403, message: 'no' } }, 403)
    );
    const e1 = await addGroupParticipants({
      token: 't',
      groupId: GID,
      participants: ['971500000001'],
    }).catch((e) => e);
    expect(e1).toBeInstanceOf(WhapiError);
    expect(e1.isNotGroupAdmin).toBe(true);

    fetchMock.mockResolvedValueOnce(
      json({ error: { code: 409, message: 'in' } }, 409)
    );
    const e2 = await addGroupParticipants({
      token: 't',
      groupId: GID,
      participants: ['971500000001'],
    }).catch((e) => e);
    expect(e2.isAlreadyParticipant).toBe(true);
  });

  it('returns icon bytes, and null on 204', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      })
    );
    const icon = await getGroupIcon({ token: 't', groupId: GID });
    expect(icon?.contentType).toBe('image/jpeg');
    expect(icon?.bytes.byteLength).toBe(3);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await getGroupIcon({ token: 't', groupId: GID })).toBeNull();
  });

  it('sets an icon with the JSON media body', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true }));
    await setGroupIcon({
      token: 't',
      groupId: GID,
      media: 'data:image/png;base64,AAAA',
      mimeType: 'image/png',
    });
    expect(call().method).toBe('PUT');
    expect(call().body).toEqual({
      media: 'data:image/png;base64,AAAA',
      mime_type: 'image/png',
    });
  });

  it('lists join requests and approves one by chat id', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        applications: [
          {
            chatId: '971500000001@s.whatsapp.net',
            request_method: 'invite_link',
            timestamp: 1717680789,
          },
        ],
        total: 1,
      })
    );
    const { requests } = await listGroupJoinRequests({
      token: 't',
      groupId: GID,
    });
    expect(requests).toEqual([
      {
        jid: '971500000001@s.whatsapp.net',
        waId: '971500000001',
        method: 'invite_link',
        requestedAt: 1717680789,
      },
    ]);

    fetchMock.mockResolvedValueOnce(
      json([
        {
          chatId: '971500000001@s.whatsapp.net',
          success: false,
          error: 'gone',
        },
      ])
    );
    const res = await approveGroupJoinRequest({
      token: 't',
      groupId: GID,
      applicant: '971500000001',
    });
    expect(call(1).method).toBe('POST');
    expect(call(1).body).toEqual({
      application: '971500000001@s.whatsapp.net',
    });
    expect(res).toEqual({ ok: false, error: 'gone' });
  });
});
