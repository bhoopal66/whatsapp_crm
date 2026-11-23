import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaseRefusedError, CaseStoreError } from '@/lib/cases/store';
import type { SubmissionGroup } from '@/lib/submission-groups/store';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  store: { findByRef: vi.fn(), listAccess: vi.fn(), get: vi.fn() },
  service: { endIfDue: vi.fn() },
  cases: {
    idForGroup: vi.fn(),
    open: vi.fn(),
    applySubmissionStatus: vi.fn(),
    get: vi.fn(),
  },
}));
vi.mock('@/lib/cases/server', () => ({ caseStore: () => m.cases }));

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
  waMode: 'group',
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
  inviteSentAt: null,
  inviteSendError: null,
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
  m.cases.idForGroup.mockResolvedValue('case-1');
  m.cases.open.mockResolvedValue({ caseId: 'case-1', created: true });
  m.cases.applySubmissionStatus.mockResolvedValue(true);
  m.cases.get.mockResolvedValue({
    id: 'case-1',
    stage: 'Approved',
    outcome: 'Approved',
  });
});

describe('PATCH moves the case', () => {
  it('applies the status to the group case and returns it', async () => {
    const res = await patch({ status: 'APPROVED' });
    expect(res.status).toBe(200);
    expect(m.cases.idForGroup).toHaveBeenCalledWith('g1');
    expect(m.cases.applySubmissionStatus).toHaveBeenCalledWith(
      'g1',
      'APPROVED'
    );
    expect((await res.json()).data.case).toEqual({
      id: 'case-1',
      stage: 'Approved',
      outcome: 'Approved',
    });
  });

  it('answers 500 when the case could not take the status, so it is sent again', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.cases.applySubmissionStatus.mockRejectedValueOnce(new Error('db down'));
    m.service.endIfDue.mockResolvedValue({
      ended: true,
      closed: true,
      closeDeferred: false,
    });
    const res = await patch({ status: 'APPROVED' });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('internal');

    // The repeat finds the group that call ended and applies it there.
    m.store.findByRef.mockResolvedValue(group({ status: 'ENDED' }));
    const again = await patch({ status: 'APPROVED' });
    err.mockRestore();
    expect(again.status).toBe(200);
    expect(m.cases.applySubmissionStatus).toHaveBeenCalledTimes(2);
    expect((await again.json()).data.case).toMatchObject({ id: 'case-1' });
  });

  it('answers 500 for a status the case could not take on an ENDED group', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.store.findByRef.mockResolvedValue(group({ status: 'ENDED' }));
    m.cases.applySubmissionStatus.mockRejectedValue(new Error('db down'));
    const res = await patch({ status: 'APPROVED' });
    err.mockRestore();
    expect(res.status).toBe(500);
  });

  it('a failed read-back still answers 200 with case null', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.cases.get.mockRejectedValue(new Error('db down'));
    const res = await patch({ status: 'APPROVED' });
    err.mockRestore();
    expect(res.status).toBe(200);
    expect(m.cases.applySubmissionStatus).toHaveBeenCalledTimes(1);
    expect((await res.json()).data.case).toBeNull();
  });

  it('opens the missing case before applying the status', async () => {
    m.cases.idForGroup.mockResolvedValueOnce(null);
    const res = await patch({ status: 'APPROVED' });
    expect(res.status).toBe(200);
    expect(m.cases.open).toHaveBeenCalledWith(
      'g1',
      { bankCode: null, bankName: null, product: null, amount: null },
      null
    );
    expect(m.cases.open.mock.invocationCallOrder[0]).toBeLessThan(
      m.cases.applySubmissionStatus.mock.invocationCallOrder[0]
    );
    expect((await res.json()).data.case).toMatchObject({ id: 'case-1' });
  });

  it('never opens (or fills) a case that exists', async () => {
    await patch({ status: 'APPROVED' });
    expect(m.cases.open).not.toHaveBeenCalled();
  });

  it('answers 500 and writes nothing when the missing case cannot be opened', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.cases.idForGroup.mockResolvedValue(null);
    m.cases.open.mockRejectedValue(new CaseStoreError('case_open', '57014'));
    const res = await patch({ status: 'APPROVED' });
    const logged = err.mock.calls.map((c) => c.join(' '));
    err.mockRestore();
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('internal');
    expect(logged).toEqual([
      '[api/v1/submission-groups] case open for group g1: cases: case_open failed (57014)',
    ]);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.service.endIfDue).not.toHaveBeenCalled();
    expect(m.cases.applySubmissionStatus).not.toHaveBeenCalled();
  });

  it('an ENDED group with no agent left goes on without a case', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.store.findByRef.mockResolvedValue(group({ status: 'ENDED' }));
    m.cases.idForGroup.mockResolvedValue(null);
    m.cases.open.mockRejectedValue(new CaseRefusedError('NO_AGENT'));
    const res = await patch({ status: 'APPROVED' });
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect((await res.json()).data.case).toBeNull();
  });

  it('answers 500 for a later status an ENDED group could not store', async () => {
    m.store.findByRef.mockResolvedValue(group({ status: 'ENDED' }));
    m.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await patch({ status: 'DISBURSED' });
    expect(res.status).toBe(500);
    expect(m.cases.applySubmissionStatus).not.toHaveBeenCalled();
  });

  it('on an ENDED group records the later status and still moves the case', async () => {
    m.store.findByRef.mockResolvedValue(group({ status: 'ENDED' }));
    const res = await patch({ status: 'APPROVED' });
    expect(m.rpc).toHaveBeenCalledWith('sg_note_submission_status', {
      p_group: 'g1',
      p_status: 'APPROVED',
    });
    expect(m.cases.applySubmissionStatus).toHaveBeenCalledWith(
      'g1',
      'APPROVED'
    );
    expect((await res.json()).data.case).toMatchObject({ id: 'case-1' });
  });
});

describe('a status sent for a closed case', () => {
  const closedAs = (stage: string) =>
    m.cases.get.mockResolvedValue({
      id: 'case-1',
      stage,
      outcome: stage,
      closedAt: new Date('2026-11-20T08:00:00Z'),
    });

  it.each(['ACTIVE', 'ENDED'])(
    'on an %s group is 200 with case_status_applied false, logged once',
    async (status) => {
      m.store.findByRef.mockResolvedValue(group({ status }));
      m.cases.applySubmissionStatus.mockResolvedValue(false);
      closedAs('Declined');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const res = await patch({ status: 'APPROVED' });
      const logged = warn.mock.calls;
      warn.mockRestore();
      expect(res.status).toBe(200);
      expect((await res.json()).data).toMatchObject({
        case_status_applied: false,
        case_status_reason: 'case_closed',
        case: { id: 'case-1', stage: 'Declined' },
      });
      expect(logged).toHaveLength(1);
    }
  );

  it('adds nothing for a repeat of the closing status, an applied one, or an open case', async () => {
    m.cases.applySubmissionStatus.mockResolvedValue(false);
    closedAs('Withdrawn');
    const repeat = await patch({ status: 'Customer_Withdrawn' });
    m.cases.get.mockResolvedValue({ id: 'case-1', stage: 'Under review' });
    const open = await patch({ status: 'WHATEVER' });
    m.cases.applySubmissionStatus.mockResolvedValue(true);
    closedAs('Approved');
    const applied = await patch({ status: 'APPROVED' });
    for (const res of [repeat, open, applied])
      expect((await res.json()).data).not.toHaveProperty('case_status_applied');
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
        mode: 'group',
        group_id: '120363000000000001@g.us',
        invite_link: 'https://chat.whatsapp.com/CODE1',
        pending: false,
        refused_participants: [],
        invite_sent: false,
        invite_sent_at: null,
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

  it('a final status on a none group ends it, with no close pending (136)', async () => {
    m.store.findByRef.mockResolvedValue(
      group({
        waMode: 'none',
        channelId: null,
        waGroupId: null,
        inviteLink: null,
      })
    );
    m.service.endIfDue.mockResolvedValue({
      ended: true,
      closed: false,
      closeDeferred: false,
    });
    m.store.get.mockResolvedValue(
      group({
        waMode: 'none',
        channelId: null,
        waGroupId: null,
        inviteLink: null,
        status: 'ENDED',
        endedAt: new Date('2026-10-16T12:00:00Z'),
      })
    );
    const res = await patch({ status: 'approved' });
    expect(res.status).toBe(200);
    expect(m.service.endIfDue).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'g1', status: 'approved' })
    );
    const data = (await res.json()).data;
    expect(data).toMatchObject({
      status: 'ENDED',
      ended: true,
      closed: false,
      close_deferred: false,
    });
    expect(data.whatsapp).toMatchObject({ mode: 'none', pending: false });
  });

  it('answers 500 and ends nothing when the status note fails', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await patch({ status: 'approved' })).status).toBe(500);
    expect(m.service.endIfDue).not.toHaveBeenCalled();
  });

  it('records a later status on an ENDED group and reports its state', async () => {
    m.store.findByRef.mockResolvedValue(
      group({
        status: 'ENDED',
        endedAt: new Date('2026-10-16T12:00:00Z'),
        waClosedAt: new Date('2026-10-16T12:01:00Z'),
      })
    );
    const res = await patch({ status: 'approved' });
    expect(res.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith('sg_note_submission_status', {
      p_group: 'g1',
      p_status: 'approved',
    });
    expect(m.service.endIfDue).not.toHaveBeenCalled();
    expect((await res.json()).data).toMatchObject({
      status: 'ENDED',
      ended: false,
      closed: true,
      close_deferred: false,
    });
  });
});
