import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { shortlistApprovedAnswers } from './shortlist';

function db(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

const GOOD = {
  id: 'e1',
  ref: 'KB-1',
  question: 'What are your fees?',
  answer_en: 'Our fees are on the website.',
  answer_ar: null,
  handoff_after: false,
  rank: 0.5,
};

describe('shortlistApprovedAnswers', () => {
  it('calls kb_shortlist with the account, query and limit', async () => {
    const { client, rpc } = db({ data: [GOOD], error: null });
    await expect(
      shortlistApprovedAnswers(client, 'acc', 'fees?', 5)
    ).resolves.toEqual([GOOD]);
    expect(rpc).toHaveBeenCalledWith('kb_shortlist', {
      p_account_id: 'acc',
      p_query: 'fees?',
      p_limit: 5,
    });
  });

  it('defaults the limit to 8', async () => {
    const { client, rpc } = db({ data: [], error: null });
    await shortlistApprovedAnswers(client, 'acc', 'fees?');
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_limit: 8 });
  });

  it('throws on an RPC error', async () => {
    const { client } = db({ data: null, error: { message: 'boom' } });
    await expect(shortlistApprovedAnswers(client, 'acc', 'q')).rejects.toThrow(
      'kb_shortlist failed: boom'
    );
  });

  it('drops malformed rows and blanks an empty Arabic answer', async () => {
    const { client } = db({
      data: [
        null,
        'x',
        { ...GOOD, id: 1 },
        { ...GOOD, answer_en: '  ' },
        { ...GOOD, handoff_after: 'true' },
        { ...GOOD, rank: '0.5' },
        { ...GOOD, question: undefined },
        { ...GOOD, id: 'e2', answer_ar: ' ' },
        { ...GOOD, id: 'e3', answer_ar: 'نعم', handoff_after: true },
      ],
      error: null,
    });
    expect(await shortlistApprovedAnswers(client, 'acc', 'q')).toEqual([
      { ...GOOD, id: 'e2', answer_ar: null },
      { ...GOOD, id: 'e3', answer_ar: 'نعم', handoff_after: true },
    ]);
  });

  it('returns nothing for a non-array result', async () => {
    const { client } = db({ data: null, error: null });
    expect(await shortlistApprovedAnswers(client, 'acc', 'q')).toEqual([]);
  });
});
