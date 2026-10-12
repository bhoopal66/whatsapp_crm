import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { META_API_BASE, MetaError } from './meta-api';
import {
  approveJoinRequests,
  createGroup,
  deleteGroup,
  getGroupInfo,
  getInviteLink,
  listJoinRequests,
  rejectJoinRequests,
  removeParticipants,
  resetInviteLink,
  sendGroupInviteTemplate,
  sendGroupMedia,
  sendGroupTemplate,
  sendGroupText,
} from './meta-groups';

// Response bodies are the samples in Meta's Groups API reference
// (normalised), so a test pins the documented contract, not a guess.
const GROUP = 'Y2FwaV9ncm91cDoxNzA1NTU1MDEzOToxMjAzNjM0MDQ2OTQyMzM4MjAZD';
const AUTH = { accessToken: 'tok' };

let fetchMock: ReturnType<typeof vi.fn>;

function respond(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(
    new Response(body === undefined ? null : JSON.stringify(body), { status })
  );
}

function lastCall(): {
  url: string;
  method: string;
  body: unknown;
  auth: string;
} {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  return {
    url,
    method: init.method ?? 'GET',
    body: init.body ? JSON.parse(String(init.body)) : undefined,
    auth: headers.Authorization,
  };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createGroup', () => {
  it('posts the documented body and keeps the request id', async () => {
    respond({ messaging_product: 'whatsapp', request_id: 'req-1' });
    const result = await createGroup({
      phoneNumberId: '106540352242922',
      ...AUTH,
      subject: '  Deal 42  ',
      description: 'Mortgage',
      joinApprovalMode: 'approval_required',
    });
    expect(result).toEqual({ requestId: 'req-1' });
    const call = lastCall();
    expect(call.url).toBe(`${META_API_BASE}/106540352242922/groups`);
    expect(call.method).toBe('POST');
    expect(call.auth).toBe('Bearer tok');
    expect(call.body).toEqual({
      messaging_product: 'whatsapp',
      subject: 'Deal 42',
      description: 'Mortgage',
      join_approval_mode: 'approval_required',
    });
  });

  it('tolerates an undocumented response: an `id`, or nothing at all', async () => {
    respond({ id: 'req-2' });
    expect(
      await createGroup({ phoneNumberId: 'p', ...AUTH, subject: 'x' })
    ).toEqual({ requestId: 'req-2' });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    expect(
      await createGroup({ phoneNumberId: 'p', ...AUTH, subject: 'x' })
    ).toEqual({ requestId: null });
  });

  it('refuses a subject over 128 characters before calling Meta', async () => {
    await expect(
      createGroup({ phoneNumberId: 'p', ...AUTH, subject: 'a'.repeat(129) })
    ).rejects.toThrow(/1 to 128/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a MetaError that names the group-specific codes', async () => {
    respond(
      {
        error: { message: 'limit', code: 131211, error_data: { details: 'd' } },
      },
      400
    );
    const err = await createGroup({
      phoneNumberId: 'p',
      ...AUTH,
      subject: 'x',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaError);
    expect((err as MetaError).isGroupCapReached).toBe(true);
    expect((err as MetaError).details).toBe('d');
  });
});

describe('MetaError group getters', () => {
  it.each([
    [131020, 'isGroupNotReady'],
    [131041, 'isGroupUnknown'],
    [131207, 'isGroupSuspended'],
    [131208, 'isGroupRateLimited'],
    [131211, 'isGroupCapReached'],
    [131214, 'isGroupCreationBlocked'],
  ] as const)('%i → %s', (code, getter) => {
    const err = new MetaError('x', 400, code);
    expect(err[getter]).toBe(true);
    expect(new MetaError('x', 400, 1)[getter]).toBe(false);
  });
});

describe('invite link', () => {
  it('gets and resets the link', async () => {
    respond({
      messaging_product: 'whatsapp',
      invite_link: 'https://chat.whatsapp.com/AAA',
    });
    expect(await getInviteLink({ groupId: GROUP, ...AUTH })).toEqual({
      inviteLink: 'https://chat.whatsapp.com/AAA',
    });
    expect(lastCall().url).toBe(`${META_API_BASE}/${GROUP}/invite_link`);
    expect(lastCall().method).toBe('GET');

    respond({
      messaging_product: 'whatsapp',
      invite_link: 'https://chat.whatsapp.com/BBB',
    });
    expect(await resetInviteLink({ groupId: GROUP, ...AUTH })).toEqual({
      inviteLink: 'https://chat.whatsapp.com/BBB',
    });
    expect(lastCall().method).toBe('POST');
    expect(lastCall().body).toEqual({ messaging_product: 'whatsapp' });
  });

  it('sends the invite as a 1:1 template with a group_id body parameter', async () => {
    respond({
      messaging_product: 'whatsapp',
      contacts: [{ input: '971501234567', wa_id: '971501234567' }],
      messages: [{ id: 'wamid.INV' }],
    });
    const result = await sendGroupInviteTemplate({
      phoneNumberId: 'p',
      ...AUTH,
      to: '971501234567',
      templateName: 'deal_room_invite',
      language: 'en',
      groupId: GROUP,
    });
    expect(result).toEqual({ messageId: 'wamid.INV' });
    expect(lastCall().body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '971501234567',
      type: 'template',
      template: {
        name: 'deal_room_invite',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [{ type: 'group_id', group_id: GROUP }],
          },
        ],
      },
    });
  });
});

describe('join requests', () => {
  it('lists requests with a quoted timestamp, paging only while `next` exists', async () => {
    respond({
      data: [
        {
          join_request_id: 'MTY0',
          wa_id: '16505551234',
          creation_timestamp: '1755548877',
        },
      ],
      paging: { cursors: { before: 'b', after: 'a' } },
    });
    expect(await listJoinRequests({ groupId: GROUP, ...AUTH })).toEqual({
      requests: [
        { joinRequestId: 'MTY0', waId: '16505551234', createdAt: 1755548877 },
      ],
      nextCursor: null,
    });
  });

  it('approves with POST and reports per-item failures (partial success)', async () => {
    respond(
      {
        messaging_product: 'whatsapp',
        approved_join_requests: ['ok-1'],
        failed_join_requests: [
          {
            join_request_id: 'bad-1',
            errors: [
              {
                code: 131203,
                message: '(#131203) Recipient has not accepted our new Terms',
              },
            ],
          },
        ],
      },
      206
    );
    const result = await approveJoinRequests({
      groupId: GROUP,
      ...AUTH,
      joinRequestIds: ['ok-1', 'bad-1'],
    });
    expect(result).toEqual({
      done: ['ok-1'],
      failed: [
        {
          joinRequestId: 'bad-1',
          code: 131203,
          message: '(#131203) Recipient has not accepted our new Terms',
        },
      ],
    });
    expect(lastCall().method).toBe('POST');
    expect(lastCall().url).toBe(`${META_API_BASE}/${GROUP}/join_requests`);
    expect(lastCall().body).toEqual({
      messaging_product: 'whatsapp',
      join_requests: ['ok-1', 'bad-1'],
    });
  });

  it('rejects with DELETE and keeps the JSON body', async () => {
    respond({ messaging_product: 'whatsapp', rejected_join_requests: ['r-1'] });
    const result = await rejectJoinRequests({
      groupId: GROUP,
      ...AUTH,
      joinRequestIds: ['r-1'],
    });
    expect(result).toEqual({ done: ['r-1'], failed: [] });
    expect(lastCall().method).toBe('DELETE');
    expect(lastCall().body).toEqual({
      messaging_product: 'whatsapp',
      join_requests: ['r-1'],
    });
  });
});

describe('participants and the group itself', () => {
  it('removes participants with DELETE and a JSON body', async () => {
    respond(undefined);
    await removeParticipants({
      groupId: GROUP,
      ...AUTH,
      participants: ['+17865347866', '16505551234', '16505551234'],
    });
    expect(lastCall().method).toBe('DELETE');
    expect(lastCall().url).toBe(`${META_API_BASE}/${GROUP}/participants`);
    expect(lastCall().body).toEqual({
      messaging_product: 'whatsapp',
      participants: [{ user: '+17865347866' }, { user: '16505551234' }],
    });
  });

  it('refuses an empty or oversized removal', async () => {
    await expect(
      removeParticipants({ groupId: GROUP, ...AUTH, participants: [] })
    ).rejects.toThrow(/1 to 8/);
    await expect(
      removeParticipants({
        groupId: GROUP,
        ...AUTH,
        participants: Array.from({ length: 9 }, (_, i) => `97150000000${i}`),
      })
    ).rejects.toThrow(/1 to 8/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads group info from the documented sample', async () => {
    respond({
      messaging_product: 'whatsapp',
      id: GROUP,
      subject: 'Artificial Intelligence Insights',
      creation_timestamp: 683731200,
      suspended: false,
      description: 'd',
      total_participant_count: 6,
      participants: [{ wa_id: '2228675309' }, { wa_id: '7693349922' }],
      join_approval_mode: 'auto_approve',
    });
    const info = await getGroupInfo({ groupId: GROUP, ...AUTH });
    expect(info).toEqual({
      id: GROUP,
      subject: 'Artificial Intelligence Insights',
      description: 'd',
      joinApprovalMode: 'auto_approve',
      suspended: false,
      createdAt: 683731200,
      participantCount: 6,
      participants: ['2228675309', '7693349922'],
    });
    expect(lastCall().url).toContain(`/${GROUP}?fields=subject,`);
  });

  it('deletes the group with a bodiless DELETE', async () => {
    respond(undefined);
    await deleteGroup({ groupId: GROUP, ...AUTH });
    expect(lastCall()).toMatchObject({
      url: `${META_API_BASE}/${GROUP}`,
      method: 'DELETE',
      body: undefined,
    });
  });
});

describe('sending to a group', () => {
  const sent = {
    messaging_product: 'whatsapp',
    contacts: [{ input: GROUP, wa_id: GROUP }],
    messages: [{ id: 'wamid.G1' }],
  };

  it('sends text with recipient_type group and the group id as `to`', async () => {
    respond(sent);
    expect(
      await sendGroupText({
        phoneNumberId: 'p',
        ...AUTH,
        groupId: GROUP,
        text: 'Hello group',
      })
    ).toEqual({ messageId: 'wamid.G1' });
    expect(lastCall().body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'group',
      to: GROUP,
      type: 'text',
      text: { body: 'Hello group' },
    });
  });

  it('sends media and templates in the same envelope', async () => {
    respond(sent);
    await sendGroupMedia({
      phoneNumberId: 'p',
      ...AUTH,
      groupId: GROUP,
      kind: 'document',
      link: 'https://example.com/a.pdf',
      caption: 'Offer',
      filename: 'a.pdf',
    });
    expect(lastCall().body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'group',
      to: GROUP,
      type: 'document',
      document: {
        link: 'https://example.com/a.pdf',
        caption: 'Offer',
        filename: 'a.pdf',
      },
    });

    respond(sent);
    await sendGroupTemplate({
      phoneNumberId: 'p',
      ...AUTH,
      groupId: GROUP,
      templateName: 'room_update',
      language: 'en',
    });
    expect(lastCall().body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'group',
      to: GROUP,
      type: 'template',
      template: { name: 'room_update', language: { code: 'en' } },
    });
  });

  it('surfaces #131020 (nobody joined yet) as isGroupNotReady', async () => {
    respond({ error: { message: 'single member group', code: 131020 } }, 400);
    const err = await sendGroupText({
      phoneNumberId: 'p',
      ...AUTH,
      groupId: GROUP,
      text: 'hi',
    }).catch((e: unknown) => e);
    expect((err as MetaError).isGroupNotReady).toBe(true);
  });
});
