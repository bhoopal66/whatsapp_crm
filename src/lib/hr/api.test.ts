import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  hrErrorCode,
  hrLinesGet,
  hrLinesSet,
  hrMemberSet,
  hrRuleSet,
  hrRulesList,
  hrSetInterview,
  hrSetStage,
} from './api';

function fakeClient(result: { data?: unknown; error?: unknown }) {
  const rpc = vi.fn().mockResolvedValue({
    data: result.data ?? null,
    error: result.error ?? null,
  });
  return { sb: { rpc } as unknown as SupabaseClient, rpc };
}

describe('hrErrorCode', () => {
  it.each([
    'NOT_ALLOWED',
    'NOT_FOUND',
    'CLOSED',
    'STAGE_UNKNOWN',
    'NEEDS_REASON',
    'INVALID',
    'LIMIT',
    'OPTED_OUT',
    'ALREADY_DECIDED',
    'STALE',
  ])('maps the hint %s', (hint) => {
    expect(hrErrorCode({ message: 'refused', code: 'P0001', hint })).toBe(hint);
  });

  it.each([
    ['an unknown hint', { hint: 'SOMETHING_ELSE' }],
    ['no hint', { message: 'boom', code: '57014' }],
    ['a null hint', { hint: null }],
    ['a thrown Error', new Error('fetch failed')],
    ['null', null],
    ['a string', 'NOT_ALLOWED'],
  ])('is UNKNOWN for %s', (_name, err) => {
    expect(hrErrorCode(err)).toBe('UNKNOWN');
  });
});

describe('hrSetStage', () => {
  it('calls hr_set_stage with the contract parameter names', async () => {
    const row = { conversation_id: 'c1', stage_key: 'hr_interview' };
    const { sb, rpc } = fakeClient({ data: row });
    await expect(
      hrSetStage(sb, 'c1', 'hr_interview', 'went back')
    ).resolves.toEqual({ data: row });
    expect(rpc).toHaveBeenCalledWith('hr_set_stage', {
      p_conversation_id: 'c1',
      p_stage: 'hr_interview',
      p_reason: 'went back',
    });
  });

  it('sends a missing reason as null', async () => {
    const { sb, rpc } = fakeClient({ data: {} });
    await hrSetStage(sb, 'c1', 'cv_review');
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_reason: null });
  });

  it('returns the refusal code instead of throwing', async () => {
    const { sb } = fakeClient({
      error: { message: 'reason required', hint: 'NEEDS_REASON' },
    });
    await expect(hrSetStage(sb, 'c1', 'cv_review')).resolves.toEqual({
      error: 'NEEDS_REASON',
    });
  });

  it('turns a rejected request into UNKNOWN', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('network'));
    const sb = { rpc } as unknown as SupabaseClient;
    await expect(hrSetStage(sb, 'c1', 'cv_review')).resolves.toEqual({
      error: 'UNKNOWN',
    });
  });
});

describe('hrSetInterview (339)', () => {
  it('calls hr_set_interview with the contract parameter names', async () => {
    const row = { conversation_id: 'c1', interview_at: '2026-12-01T07:00:00Z' };
    const { sb, rpc } = fakeClient({ data: row });
    await expect(
      hrSetInterview(sb, 'c1', '2026-12-01T07:00:00.000Z')
    ).resolves.toEqual({ data: row });
    expect(rpc).toHaveBeenCalledWith('hr_set_interview', {
      p_conversation_id: 'c1',
      p_at: '2026-12-01T07:00:00.000Z',
    });
  });

  it('sends a cleared time as null', async () => {
    const { sb, rpc } = fakeClient({ data: {} });
    await hrSetInterview(sb, 'c1', null);
    expect(rpc.mock.calls[0][1]).toEqual({
      p_conversation_id: 'c1',
      p_at: null,
    });
  });

  it('returns the refusal code instead of throwing', async () => {
    for (const hint of ['CLOSED', 'INVALID', 'NOT_ALLOWED'] as const) {
      const { sb } = fakeClient({ error: { message: 'no', hint } });
      await expect(hrSetInterview(sb, 'c1', null)).resolves.toEqual({
        error: hint,
      });
    }
  });
});

describe('void and list results', () => {
  it('hrMemberSet answers data null', async () => {
    const { sb, rpc } = fakeClient({ data: '' });
    await expect(hrMemberSet(sb, 'u1', 'dept', null)).resolves.toEqual({
      data: null,
    });
    expect(rpc).toHaveBeenCalledWith('hr_member_set', {
      p_user_id: 'u1',
      p_inbox: 'dept',
      p_role: null,
    });
  });

  it('hrRulesList reads a null body as no rules', async () => {
    const { sb } = fakeClient({ data: null });
    await expect(hrRulesList(sb)).resolves.toEqual({ data: [] });
  });
});

describe('hrRuleSet (335)', () => {
  it('sends the Arabic title, and null for every field not in the patch', async () => {
    const { sb, rpc } = fakeClient({ data: { key: 'stage_cv_review' } });
    await hrRuleSet(sb, 'stage_cv_review', {
      titleAr: 'مراجعة السيرة الذاتية',
    });
    expect(rpc).toHaveBeenCalledWith('hr_rule_set', {
      p_key: 'stage_cv_review',
      p_enabled: null,
      p_after_hours: null,
      p_due_hours: null,
      p_title: null,
      p_title_ar: 'مراجعة السيرة الذاتية',
    });
  });

  it('sends an empty Arabic title as is: it clears it', async () => {
    const { sb, rpc } = fakeClient({ data: { key: 'stage_cv_review' } });
    await hrRuleSet(sb, 'stage_cv_review', { titleAr: '' });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_title_ar: '' });
  });
});

describe('HR lines (213)', () => {
  const lines = {
    auto_open_recruiter: true,
    channel_ids: ['a', 'b'],
    updated_at: '2026-11-20T10:00:00+00:00',
  };

  it('hrLinesGet calls hr_lines_get with no arguments', async () => {
    const { sb, rpc } = fakeClient({ data: lines });
    await expect(hrLinesGet(sb)).resolves.toEqual({ data: lines });
    expect(rpc).toHaveBeenCalledWith('hr_lines_get', undefined);
  });

  it('hrLinesSet sends the contract parameter names', async () => {
    const { sb, rpc } = fakeClient({ data: lines });
    await expect(
      hrLinesSet(sb, ['a', 'b'], true, '2026-11-20T09:00:00+00:00')
    ).resolves.toEqual({
      data: lines,
    });
    expect(rpc).toHaveBeenCalledWith('hr_lines_set', {
      p_channel_ids: ['a', 'b'],
      p_auto_open: true,
      p_expected: '2026-11-20T09:00:00+00:00',
    });
  });

  it.each(['NOT_ALLOWED', 'INVALID', 'STALE'])(
    'hrLinesSet returns the %s refusal',
    async (hint) => {
      const { sb } = fakeClient({ error: { message: 'refused', hint } });
      await expect(hrLinesSet(sb, [], false, null)).resolves.toEqual({
        error: hint,
      });
    }
  );
});
