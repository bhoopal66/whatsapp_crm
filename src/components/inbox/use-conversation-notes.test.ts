import { describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc }) }));

import { fetchMentionCandidates } from './use-conversation-notes';

describe('fetchMentionCandidates', () => {
  it('tells "could not read" from "nobody"', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error('timeout') });
    expect(await fetchMentionCandidates('c')).toBeNull();
    rpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await fetchMentionCandidates('c')).toEqual([]);
    const sara = { user_id: 'u', full_name: 'Sara' };
    rpc.mockResolvedValueOnce({ data: [sara], error: null });
    expect(await fetchMentionCandidates('c')).toEqual([sara]);
  });
});
