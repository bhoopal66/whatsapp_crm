import { describe, expect, it, vi } from 'vitest';
import { saveDraft, sendReopenedDraft, type SaveDraftDeps } from './draft-send';

const row = { data: [{ id: 'd1' }], error: null };

function harness(over: {
  draftId?: string | null;
  claim?: () => Promise<{
    data: { id: string }[] | null;
    error: { message: string } | null;
  }>;
  create?: (onCampaign: (id: string) => void) => Promise<string>;
}) {
  const calls: string[] = [];
  const run = sendReopenedDraft<string>({
    draftId: over.draftId === undefined ? 'd1' : over.draftId,
    claim: async (id) => {
      calls.push(`claim:${id}`);
      return over.claim ? over.claim() : row;
    },
    create: async (onCampaign) => {
      calls.push('create');
      return over.create ? over.create(onCampaign) : 'c1';
    },
    restore: async () => {
      calls.push('restore');
      return { kind: 'saved', id: 'd2' };
    },
  });
  return { calls, run };
}

describe('sendReopenedDraft', () => {
  it('claims the draft before creating anything', async () => {
    const { calls, run } = harness({});
    expect(await run).toEqual({ kind: 'sent', outcome: 'c1' });
    expect(calls).toEqual(['claim:d1', 'create']);
  });

  it('creates nothing when another tab already took the draft', async () => {
    const { calls, run } = harness({
      claim: async () => ({ data: [], error: null }),
    });
    expect(await run).toEqual({ kind: 'claim_lost' });
    expect(calls).toEqual(['claim:d1']);
  });

  it('creates nothing when the claim errors or throws', async () => {
    const failed = harness({
      claim: async () => ({ data: null, error: { message: 'boom' } }),
    });
    expect(await failed.run).toEqual({ kind: 'claim_failed', message: 'boom' });
    expect(failed.calls).toEqual(['claim:d1']);
    const thrown = harness({
      claim: async () => {
        throw new Error('offline');
      },
    });
    expect(await thrown.run).toEqual({
      kind: 'claim_failed',
      message: 'offline',
    });
    expect(thrown.calls).toEqual(['claim:d1']);
  });

  it('lets only one of two openers send', async () => {
    let left = 1;
    const claim = async () => ({
      data: left-- > 0 ? [{ id: 'd1' }] : [],
      error: null,
    });
    const results = await Promise.all([
      harness({ claim }).run,
      harness({ claim }).run,
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(['claim_lost', 'sent']);
  });

  it('restores the draft when no campaign row was created', async () => {
    const error = new Error('No contacts found');
    const { calls, run } = harness({
      create: async () => {
        throw error;
      },
    });
    expect(await run).toEqual({
      kind: 'failed',
      error,
      campaignId: null,
      restored: { kind: 'saved', id: 'd2' },
    });
    expect(calls).toEqual(['claim:d1', 'create', 'restore']);
  });

  it('never restores the draft once the campaign exists', async () => {
    const error = new Error('delivery failed');
    const { calls, run } = harness({
      create: async (onCampaign) => {
        onCampaign('c9');
        throw error;
      },
    });
    expect(await run).toEqual({
      kind: 'failed',
      error,
      campaignId: 'c9',
      restored: null,
    });
    expect(calls).toEqual(['claim:d1', 'create']);
  });

  it('claims and restores nothing for a broadcast with no draft', async () => {
    const { calls, run } = harness({
      draftId: null,
      create: async () => {
        throw new Error('x');
      },
    });
    expect(await run).toMatchObject({ kind: 'failed', restored: null });
    expect(calls).toEqual(['create']);
  });
});

describe('saveDraft', () => {
  const deps = (over: Partial<SaveDraftDeps> = {}) => ({
    draftId: 'd1' as string | null,
    update: vi.fn(async () => row),
    insert: vi.fn(async () => ({ data: { id: 'new' }, error: null })),
    saveState: vi.fn(async () => ({ error: null })),
    ...over,
  });

  it('updates the same draft, never inserting a second', async () => {
    const d = deps();
    expect(await saveDraft(d)).toEqual({ kind: 'saved', id: 'd1' });
    expect(d.insert).not.toHaveBeenCalled();
    expect(d.saveState).toHaveBeenCalledWith('d1');
  });

  it('does not resurrect a draft another tab sent', async () => {
    const d = deps({ update: vi.fn(async () => ({ data: [], error: null })) });
    expect(await saveDraft(d)).toEqual({ kind: 'gone' });
    expect(d.insert).not.toHaveBeenCalled();
    expect(d.saveState).not.toHaveBeenCalled();
  });

  it('reports a draft that went between the two writes as gone', async () => {
    const d = deps({
      saveState: vi.fn(async () => ({
        error: { message: 'fk', code: '23503' },
      })),
    });
    expect(await saveDraft(d)).toEqual({ kind: 'gone' });
  });

  it('keeps the new row id when its state fails, so a retry updates it', async () => {
    const d = deps({
      draftId: null,
      saveState: vi.fn(async () => ({ error: { message: 'no' } })),
    });
    expect(await saveDraft(d)).toEqual({
      kind: 'failed',
      id: 'new',
      message: 'no',
    });
  });
});
