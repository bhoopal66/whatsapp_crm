import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmissionGroup } from '@/lib/submission-groups/store';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  store: { findByRef: vi.fn(), listAccess: vi.fn(), get: vi.fn() },
  service: { endIfDue: vi.fn() },
  cases: { idForGroup: vi.fn(), applySubmissionStatus: vi.fn(), get: vi.fn() },
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

import { PATCH } from './route';

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
  inviteSentAt: null,
  inviteSendError: null,
  ...over,
});

const params = { params: Promise.resolve({ submissionId: ' SUB-1 ' }) };
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
  m.cases.applySubmissionStatus.mockResolvedValue(true);
  m.cases.get.mockResolvedValue({
    id: 'case-1',
    stage: 'Approved',
    outcome: 'Approved',
  });
});

const syncOk = (over: Record<string, unknown> = {}) => ({
  data: {
    applied: true,
    stage: 'Submitted',
    outcome: null,
    final: false,
    rejected: [],
    changes: ['stage'],
    ...over,
  },
  error: null,
});

describe('PATCH case sync (migration 134)', () => {
  it('a sync-only body calls case_sync_from_submission and answers sync, ending nothing', async () => {
    m.rpc.mockResolvedValueOnce(
      syncOk({ rejected: [{ key: 'x', error: 'DOC_NOT_REQUIRED' }] })
    );
    const res = await patch({
      changed_at: '2026-10-21T10:00:00Z',
      stage: 'Submitted',
      documents: [{ key: 'x', status: 'received' }],
    });
    expect(res.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc).toHaveBeenCalledWith('case_sync_from_submission', {
      p_group: 'g1',
      p_changed_at: '2026-10-21T10:00:00.000Z',
      p_patch: {
        stage: 'Submitted',
        documents: [{ key: 'x', status: 'received' }],
      },
    });
    expect(m.service.endIfDue).not.toHaveBeenCalled();
    expect(m.cases.applySubmissionStatus).not.toHaveBeenCalled();
    expect((await res.json()).data.sync).toEqual({
      applied: true,
      rejected: [{ key: 'x', error: 'DOC_NOT_REQUIRED' }],
      changes: ['stage'],
    });
  });

  it('a final stage ends an ACTIVE group through endIfDue', async () => {
    m.rpc.mockResolvedValueOnce(
      syncOk({ stage: 'Declined', outcome: 'Declined', final: true })
    );
    m.service.endIfDue.mockResolvedValue({
      ended: true,
      closed: true,
      closeDeferred: false,
    });
    const res = await patch({ stage: 'Declined' });
    expect(m.service.endIfDue).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'g1', status: 'Declined' })
    );
    expect((await res.json()).data).toMatchObject({
      ended: true,
      closed: true,
    });
  });

  it('with a status too, records it and ends on the final stage', async () => {
    m.rpc
      .mockResolvedValueOnce(syncOk({ stage: 'Approved', final: true }))
      .mockResolvedValueOnce({ data: null, error: null });
    await patch({ status: 'BANK_REVIEW', stage: 'Approved' });
    expect(m.rpc).toHaveBeenNthCalledWith(2, 'sg_note_submission_status', {
      p_group: 'g1',
      p_status: 'BANK_REVIEW',
    });
    expect(m.service.endIfDue).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'Approved' })
    );
    expect(m.cases.applySubmissionStatus).toHaveBeenCalledWith(
      'g1',
      'BANK_REVIEW'
    );
  });

  it('a stale update is 200 with applied false', async () => {
    m.rpc.mockResolvedValueOnce({
      data: { applied: false, reason: 'stale' },
      error: null,
    });
    const res = await patch({ changed_at: '2026-10-01T00:00:00Z', stage: 'X' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.sync).toEqual({
      applied: false,
      reason: 'stale',
      rejected: [],
      changes: [],
    });
    expect(m.service.endIfDue).not.toHaveBeenCalled();
  });

  it('maps a raised refusal to 422 with the lower-case code, touching nothing else', async () => {
    m.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: 'P0001',
        hint: 'PRESUB_REENTRY',
        message: 'PRESUB_REENTRY: …',
      },
    });
    const res = await patch({ status: 'APPROVED', stage: 'Interested' });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('presub_reentry');
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.service.endIfDue).not.toHaveBeenCalled();
  });

  it('answers 500 on another database error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014' } });
    expect((await patch({ stage: 'Submitted' })).status).toBe(500);
  });

  it('syncs an ENDED group too, never ending it again', async () => {
    m.store.findByRef.mockResolvedValue(group({ status: 'ENDED' }));
    m.rpc.mockResolvedValueOnce(syncOk({ stage: 'Approved', final: true }));
    const res = await patch({ stage: 'Approved' });
    expect(m.rpc).toHaveBeenCalledWith(
      'case_sync_from_submission',
      expect.objectContaining({ p_group: 'g1' })
    );
    expect(m.service.endIfDue).not.toHaveBeenCalled();
    expect((await res.json()).data).toMatchObject({
      ended: false,
      sync: { applied: true },
    });
  });

  it('a status-only answer carries no sync key', async () => {
    const res = await patch({ status: 'approved' });
    expect((await res.json()).data).not.toHaveProperty('sync');
  });
});
