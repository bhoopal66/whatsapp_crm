import { describe, expect, it, vi } from 'vitest';

import { readJudgment, suggestTrayCase } from './suggest';

const ok = (index: number | null, p: number, pRunnerUp = 0) =>
  ({ ok: true, index, p, pRunnerUp, latencyMs: 1 }) as const;

describe('readJudgment', () => {
  it('suggests only a clear pick, never a tie or a guess', () => {
    expect(readJudgment(ok(1, 0.9, 0.05), ['a', 'b'])).toEqual({
      status: 'suggested',
      caseId: 'b',
      p: 0.9,
    });
    expect(readJudgment(ok(0, 0.55), ['a', 'b'])).toEqual({ status: 'unsure' });
    expect(readJudgment(ok(null, 0.95), ['a', 'b'])).toEqual({
      status: 'unsure',
    });
    expect(readJudgment(ok(0, 0.62, 0.58), ['a', 'b'])).toEqual({
      status: 'tie',
    });
    expect(
      readJudgment({ ok: false, errorCode: 'TIMEOUT', latencyMs: 1 } as never, [
        'a',
      ])
    ).toEqual({ status: 'failed' });
    expect(readJudgment(ok(5, 0.9), ['a'])).toEqual({ status: 'failed' });
  });
});

const INPUT = {
  kind: 'document',
  mime: 'application/pdf',
  caption: 'ejari copy',
  original_name: 'ejari.pdf',
  candidates: [
    {
      case_id: 'kR',
      bank_code: 'RAK',
      product: 'Business account',
      missing: ['Ejari'],
    },
    {
      case_id: 'kE',
      bank_code: 'ENBD',
      product: 'Business account',
      missing: ['KYC form'],
    },
  ],
};

describe('suggestTrayCase', () => {
  it('asks Jev with banks, products and missing documents only, and maps the answer back', async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: INPUT, error: null }) };
    const judge = vi.fn().mockResolvedValue(ok(0, 0.85, 0.1));
    const out = await suggestTrayCase(db, 'u1', 'a1', 't1', {
      available: () => true,
      judge,
    });
    expect(out.suggestion).toEqual({
      status: 'suggested',
      caseId: 'kR',
      p: 0.85,
    });
    expect(db.rpc).toHaveBeenCalledWith('desk_tray_suggest_input', {
      p_actor: 'u1',
      p_account: 'a1',
      p_tray: 't1',
    });
    const sent = judge.mock.calls[0]![0];
    expect(sent.candidates).toEqual([
      { bank: 'RAK', product: 'Business account', stillNeeds: ['Ejari'] },
      { bank: 'ENBD', product: 'Business account', stillNeeds: ['KYC form'] },
    ]);
    expect(JSON.stringify(sent)).not.toContain('kR');
  });

  it('is off without the insights layer, and never throws on a failed call', async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: INPUT, error: null }) };
    expect(
      (await suggestTrayCase(db, 'u1', 'a1', 't1', { available: () => false }))
        .suggestion
    ).toEqual({ status: 'off' });
    const judge = vi.fn().mockRejectedValue(new Error('down'));
    expect(
      (
        await suggestTrayCase(db, 'u1', 'a1', 't1', {
          available: () => true,
          judge,
        })
      ).suggestion
    ).toEqual({ status: 'failed' });
  });

  it('lets the SQL refusal through for the route to map', async () => {
    const db = {
      rpc: vi
        .fn()
        .mockResolvedValue({
          data: null,
          error: { hint: 'TRAY_NOT_FOUND', code: '23514' },
        }),
    };
    await expect(suggestTrayCase(db, 'u1', 'a1', 't1')).rejects.toMatchObject({
      hint: 'TRAY_NOT_FOUND',
    });
  });
});
