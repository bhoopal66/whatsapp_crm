import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmissionGroup } from '@/lib/submission-groups/store';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  store: { findByRef: vi.fn(), listAccess: vi.fn(), get: vi.fn() },
  service: { endIfDue: vi.fn() },
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async () => ({
    accountId: 'acct-1',
    supabase: { rpc: m.rpc },
    keyId: 'key-1',
  })),
}));
vi.mock('@/lib/submission-groups/server', () => ({
  submissionGroupStore: () => m.store,
  submissionGroupService: () => m.service,
}));

import { GET, PATCH } from './route';

const group = (over: Partial<SubmissionGroup> = {}): SubmissionGroup => ({
  id: 'g1',
  accountId: 'acct-1',
  submissionRef: 'SUB-1',
  contactId: 'c1',
  channelId: 'w1',
  subject: 'Jane · SUB-1',
  coordinatorPhone: null,
  status: 'ACTIVE',
  waGroupId: '120363000000000001@g.us',
  inviteLink: 'https://chat.whatsapp.com/CODE1',
  submissionStatus: null,
  createdAt: new Date('2026-10-16T10:00:00Z'),
  lastActivityAt: new Date('2026-10-16T11:00:00Z'),
  endedAt: null,
  endReason: null,
  waCreateError: null,
  waClosedAt: null,
  waCloseError: null,
  ...over,
});

const params = { params: Promise.resolve({ submissionId: ' SUB-1 ' }) };
const get = () => GET(new Request('http://x'), params);
const patch = (body: unknown) =>
  PATCH(
    new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }),
    params
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.store.findByRef.mockResolvedValue(group());
  m.store.listAccess.mockResolvedValue([{ userId: 'u-agent', label: 'agent' }]);
  m.store.get.mockResolvedValue(null);
  m.rpc.mockResolvedValue({ data: null, error: null });
  m.service.endIfDue.mockResolvedValue({
    ended: false,
    closed: false,
    closeDeferred: false,
  });
});

describe('GET /api/v1/submission-groups/{submission_id}', () => {
  it('answers 404 for an unknown submission', async () => {
    m.store.findByRef.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('answers the group in the wire shape, looked up in the key account', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(m.store.findByRef).toHaveBeenCalledWith('acct-1', 'SUB-1');
    expect((await res.json()).data).toEqual({
      id: 'g1',
      submission_id: 'SUB-1',
      status: 'ACTIVE',
      submission_status: null,
      channel_id: 'w1',
      contact_id: 'c1',
      whatsapp: {
        group_id: '120363000000000001@g.us',
        invite_link: 'https://chat.whatsapp.com/CODE1',
        pending: false,
        refused_participants: [],
        invite_sent: false,
      },
      access: [{ user_id: 'u-agent', label: 'agent' }],
      created_at: '2026-10-16T10:00:00.000Z',
      ended_at: null,
    });
  });
});

describe('PATCH /api/v1/submission-groups/{submission_id}', () => {
  it('answers 400 for a missing or blank status', async () => {
    expect((await patch({})).status).toBe(400);
    expect((await patch({ status: '  ' })).status).toBe(400);
    expect(m.store.findByRef).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown submission', async () => {
    m.store.findByRef.mockResolvedValue(null);
    expect((await patch({ status: 'approved' })).status).toBe(404);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('records the status on an ACTIVE group, then ends it when due', async () => {
    m.service.endIfDue.mockResolvedValue({
      ended: true,
      closed: false,
      closeDeferred: true,
    });
    m.store.get.mockResolvedValue(
      group({ status: 'ENDED', endedAt: new Date('2026-10-16T12:00:00Z') })
    );
    const res = await patch({ status: ' approved ' });
    expect(res.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith('sg_note_submission_status', {
      p_group: 'g1',
      p_status: 'approved',
    });
    expect(m.service.endIfDue).toHaveBeenCalledWith({
      groupId: 'g1',
      status: 'approved',
      lastActivityAt: new Date('2026-10-16T11:00:00Z'),
      idleDays: null,
      now: expect.any(Date),
    });
    expect((await res.json()).data).toMatchObject({
      status: 'ENDED',
      ended: true,
      closed: false,
      close_deferred: true,
    });
  });

  it('answers 500 and ends nothing when the status note fails', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await patch({ status: 'approved' })).status).toBe(500);
    expect(m.service.endIfDue).not.toHaveBeenCalled();
  });

  it('records nothing on an ENDED group and reports its state', async () => {
    m.store.findByRef.mockResolvedValue(
      group({
        status: 'ENDED',
        endedAt: new Date('2026-10-16T12:00:00Z'),
        waClosedAt: new Date('2026-10-16T12:01:00Z'),
      })
    );
    const res = await patch({ status: 'approved' });
    expect(res.status).toBe(200);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.service.endIfDue).not.toHaveBeenCalled();
    expect((await res.json()).data).toMatchObject({
      status: 'ENDED',
      ended: false,
      closed: true,
      close_deferred: false,
    });
  });
});
