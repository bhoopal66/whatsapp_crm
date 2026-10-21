import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmissionGroup } from '@/lib/submission-groups/store';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  store: { findByRef: vi.fn(), listAccess: vi.fn(), get: vi.fn() },
  service: { endIfDue: vi.fn() },
  cases: {
    idForGroup: vi.fn(),
    applySubmissionStatus: vi.fn(),
    get: vi.fn(),
    endClaimedGroup: vi.fn(),
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

const TOKEN = '2026-10-21T10:00:00.123456+00:00';

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
  m.cases.endClaimedGroup.mockResolvedValue({
    groupEnded: true,
    reason: 'ENDED',
    end: {
      ended: true,
      reason: 'CASE_DECLINED',
      closed: true,
      closeError: null,
      closeDeferred: false,
    },
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

  it('a final stage on an ACTIVE group ends it through the case path with the claim token', async () => {
    m.rpc.mockResolvedValueOnce(
      syncOk({
        case_id: 'case-1',
        stage: 'Declined',
        outcome: 'Declined',
        final: true,
        group_end_token: TOKEN,
      })
    );
    const res = await patch({ stage: 'Declined' });
    expect(m.cases.endClaimedGroup).toHaveBeenCalledWith(
      'case-1',
      'Declined',
      TOKEN
    );
    expect(m.service.endIfDue).not.toHaveBeenCalled();
    expect((await res.json()).data).toMatchObject({
      ended: true,
      closed: true,
      close_deferred: false,
    });
  });

  it('a failed case end answers ended false and never falls back to endIfDue', async () => {
    m.rpc.mockResolvedValueOnce(
      syncOk({
        case_id: 'case-1',
        stage: 'Approved',
        final: true,
        group_end_token: TOKEN,
      })
    );
    m.cases.endClaimedGroup.mockResolvedValue({
      groupEnded: false,
      reason: 'END_FAILED',
      end: null,
    });
    const res = await patch({ stage: 'Approved', status: 'APPROVED' });
    expect(m.cases.endClaimedGroup).toHaveBeenCalledWith(
      'case-1',
      'Approved',
      TOKEN
    );
    expect(m.service.endIfDue).not.toHaveBeenCalled();
    expect((await res.json()).data).toMatchObject({
      ended: false,
      close_deferred: false,
    });
  });

  it('a final move without a token (claim held elsewhere) ends nothing itself', async () => {
    m.rpc.mockResolvedValueOnce(
      syncOk({ case_id: 'case-1', stage: 'Closed', final: true })
    );
    await patch({ stage: 'Closed' });
    expect(m.cases.endClaimedGroup).not.toHaveBeenCalled();
    expect(m.service.endIfDue).not.toHaveBeenCalled();
  });

  it('with a status too, records it and ends through the case path', async () => {
    m.rpc
      .mockResolvedValueOnce(
        syncOk({
          case_id: 'case-1',
          stage: 'Approved',
          final: true,
          group_end_token: TOKEN,
        })
      )
      .mockResolvedValueOnce({ data: null, error: null });
    await patch({ status: 'BANK_REVIEW', stage: 'Approved' });
    expect(m.rpc).toHaveBeenNthCalledWith(2, 'sg_note_submission_status', {
      p_group: 'g1',
      p_status: 'BANK_REVIEW',
    });
    expect(m.cases.endClaimedGroup).toHaveBeenCalledWith(
      'case-1',
      'Approved',
      TOKEN
    );
    expect(m.service.endIfDue).not.toHaveBeenCalled();
    expect(m.cases.applySubmissionStatus).toHaveBeenCalledWith(
      'g1',
      'BANK_REVIEW'
    );
  });

  it('a failed status note still settles the claim the sync took', async () => {
    m.rpc
      .mockResolvedValueOnce(
        syncOk({
          case_id: 'case-1',
          stage: 'Declined',
          final: true,
          group_end_token: TOKEN,
        })
      )
      .mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    const res = await patch({ status: 'DECLINED', stage: 'Declined' });
    expect(res.status).toBe(500);
    expect(m.cases.endClaimedGroup).toHaveBeenCalledWith(
      'case-1',
      'Declined',
      TOKEN
    );
    expect(m.service.endIfDue).not.toHaveBeenCalled();
  });

  it('a stale update with a final status records and ends nothing', async () => {
    m.rpc.mockResolvedValueOnce({
      data: { applied: false, reason: 'stale' },
      error: null,
    });
    const res = await patch({
      changed_at: '2026-10-01T00:00:00Z',
      status: 'APPROVED',
    });
    expect(res.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc).not.toHaveBeenCalledWith(
      'sg_note_submission_status',
      expect.anything()
    );
    expect(m.service.endIfDue).not.toHaveBeenCalled();
    expect(m.cases.endClaimedGroup).not.toHaveBeenCalled();
    expect(m.cases.applySubmissionStatus).not.toHaveBeenCalled();
    expect((await res.json()).data).toMatchObject({
      ended: false,
      case: { id: 'case-1' },
      sync: { applied: false, reason: 'stale' },
    });
  });

  it('a stale update on an ENDED group does not apply its status to the case', async () => {
    m.store.findByRef.mockResolvedValue(group({ status: 'ENDED' }));
    m.rpc.mockResolvedValueOnce({
      data: { applied: false, reason: 'stale' },
      error: null,
    });
    await patch({ changed_at: '2026-10-01T00:00:00Z', status: 'APPROVED' });
    expect(m.cases.applySubmissionStatus).not.toHaveBeenCalled();
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
