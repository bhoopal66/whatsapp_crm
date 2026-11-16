import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { hrErrorCode, hrMemberSet, hrRulesList, hrSetStage } from './api';

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
