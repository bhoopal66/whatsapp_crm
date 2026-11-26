import type { PostgrestError } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import type { RowWriter } from '@/lib/supabase/changed-rows';
import { deleteContacts, loadDeletePreview } from './delete-contacts';

type Answer = { data: unknown; error: Partial<PostgrestError> | null };

const ok = (...ids: string[]): Answer => ({
  data: ids.map((id) => ({ id })),
  error: null,
});
const hold: Answer = { data: null, error: { hint: 'LEGAL_HOLD' } };
const work: Answer = {
  data: null,
  error: {
    code: 'ZC280',
    hint: 'HAS_OPEN_WORK',
    details: '{"cases": 1, "deal_rooms": 0, "submission_groups": 0}',
  },
};
const timeout: Answer = { data: null, error: { code: '57014', hint: '' } };
const none = { legalHold: false, cases: 0, dealRooms: 0, submissionGroups: 0 };

/** Answers each DELETE by its ids, joined. */
function fakeTable(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const sb = {
    from: () => ({
      delete: () => ({
        in: (_: string, ids: string[]) => ({
          select: async () => {
            asked.push(ids.join());
            return answers[ids.join()];
          },
        }),
      }),
    }),
  };
  return { sb: sb as unknown as RowWriter, asked };
}

describe('deleteContacts', () => {
  it('is one statement when nobody is refused', async () => {
    const { sb, asked } = fakeTable({ 'a,b': ok('a') });
    expect(await deleteContacts(sb, ['a', 'b'])).toEqual({
      deleted: ['a'],
      refused: [],
      failed: [],
    });
    expect(asked).toEqual(['a,b']);
  });

  it.each([
    ['open work', work],
    ['a legal hold', hold],
  ])('asks for each on its own after %s', async (_, first) => {
    const { sb, asked } = fakeTable({
      'a,b,c,d': first,
      a: ok('a'),
      b: work,
      c: hold,
      d: timeout,
    });
    expect(await deleteContacts(sb, ['a', 'b', 'c', 'd'])).toEqual({
      deleted: ['a'],
      refused: [
        { id: 'b', ...none, cases: 1 },
        { id: 'c', ...none, legalHold: true },
      ],
      failed: ['d'],
    });
    expect(asked).toEqual(['a,b,c,d', 'a', 'b', 'c', 'd']);
  });

  it('does not retry any other failure, nor a single customer', async () => {
    const many = fakeTable({ 'a,b': timeout });
    expect((await deleteContacts(many.sb, ['a', 'b'])).failed).toEqual([
      'a',
      'b',
    ]);
    const one = fakeTable({ a: work });
    expect((await deleteContacts(one.sb, ['a'])).refused).toHaveLength(1);
    expect([many.asked, one.asked]).toEqual([['a,b'], ['a']]);
  });
});

describe('loadDeletePreview', () => {
  const counts = (chats: number, blocked: string[] = []) => ({
    data: {
      chats,
      blocked: blocked.map((id) => ({ contact_id: id, legal_hold: true })),
    },
    error: null,
  });
  function fakeRpc(answers: Record<string, Answer>) {
    const asked: string[] = [];
    const rpc = async (name: string, args: { p_contacts: string[] }) => {
      expect(name).toBe('contact_delete_preview');
      asked.push(args.p_contacts.join());
      return answers[args.p_contacts.join()];
    };
    return {
      sb: { rpc } as unknown as Parameters<typeof loadDeletePreview>[0],
      asked,
    };
  }

  it('fails without the function', async () => {
    const { sb } = fakeRpc({ a: { data: null, error: { code: 'PGRST202' } } });
    expect(await loadDeletePreview(sb, ['a'])).toEqual({ kind: 'failed' });
  });

  it('counts only what the delete will take', async () => {
    const { sb, asked } = fakeRpc({ 'a,b': counts(9, ['b']), a: counts(2) });
    expect(await loadDeletePreview(sb, ['a', 'b'])).toMatchObject({
      kind: 'ready',
      preview: { chats: 2, blocked: [{ id: 'b', legalHold: true }] },
    });
    expect(asked).toEqual(['a,b', 'a']);
  });

  it('keeps the blocked ones, without counts, if the second read fails', async () => {
    const { sb } = fakeRpc({ 'a,b': counts(9, ['b']), a: timeout });
    expect(await loadDeletePreview(sb, ['a', 'b'])).toMatchObject({
      kind: 'ready',
      preview: { chats: 0, blocked: [{ id: 'b' }] },
    });
  });

  it.each([
    ['nobody is', counts(2)],
    ['everybody is', counts(2, ['a'])],
  ])('asks once when %s blocked', async (_, res) => {
    const { sb, asked } = fakeRpc({ a: res });
    await loadDeletePreview(sb, ['a']);
    expect(asked).toEqual(['a']);
  });
});
