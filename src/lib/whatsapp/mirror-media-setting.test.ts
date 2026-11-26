import { describe, expect, it } from 'vitest';

import {
  MirrorNotSavedError,
  saveMirrorInboundMedia,
} from './mirror-media-setting';

function client(answer: { data: unknown; error: unknown }) {
  const calls: unknown[] = [];
  const chain = {
    update: (patch: unknown) => {
      calls.push(patch);
      return chain;
    },
    eq: (col: string, v: string) => {
      calls.push([col, v]);
      return chain;
    },
    select: (cols: string) => {
      calls.push(cols);
      return Promise.resolve(answer);
    },
  };
  return { sb: { from: () => chain } as never, calls };
}

describe('saveMirrorInboundMedia', () => {
  it('saves when the row changed', async () => {
    const { sb, calls } = client({ data: [{ id: 'c1' }], error: null });
    await expect(
      saveMirrorInboundMedia(sb, 'c1', true)
    ).resolves.toBeUndefined();
    expect(calls).toContainEqual({ mirror_inbound_media: true });
    expect(calls).toContainEqual(['id', 'c1']);
  });

  it('refuses a write that changed no row (RLS filtered it)', async () => {
    const { sb } = client({ data: [], error: null });
    await expect(saveMirrorInboundMedia(sb, 'c1', true)).rejects.toBeInstanceOf(
      MirrorNotSavedError
    );
  });

  it('throws the database error', async () => {
    const { sb } = client({ data: null, error: { message: 'boom' } });
    await expect(saveMirrorInboundMedia(sb, 'c1', false)).rejects.toThrow(
      'boom'
    );
  });
});
