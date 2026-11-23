import { afterEach, describe, expect, it, vi } from 'vitest';

import { listMessageTemplates } from './meta-api';

// Sync disables what the list does not name, so the list says whether it
// is whole.

const pages = (next: (call: number) => unknown) => {
  let call = 0;
  const fetchMock = vi.fn(async () => Response.json(next(call++)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const list = () => listMessageTemplates({ wabaId: 'w', accessToken: 't' });

afterEach(() => vi.unstubAllGlobals());

describe('listMessageTemplates', () => {
  it('follows the pages to the end', async () => {
    pages((i) =>
      i === 0
        ? { data: [{ id: '1' }], paging: { next: 'https://x/2' } }
        : { data: [{ id: '2' }], paging: {} }
    );
    const r = await list();
    expect(r.templates.map((t) => t.id)).toEqual(['1', '2']);
    expect(r.complete).toBe(true);
  });

  it('calls an empty registry complete', async () => {
    pages(() => ({ data: [] }));
    expect(await list()).toEqual({ templates: [], complete: true });
  });

  it('is incomplete when an answer has no data', async () => {
    pages((i) =>
      i === 0 ? { data: [{ id: '1' }], paging: { next: 'https://x/2' } } : {}
    );
    const r = await list();
    expect(r.templates.map((t) => t.id)).toEqual(['1']);
    expect(r.complete).toBe(false);
  });

  it('is incomplete when the page bound stops it', async () => {
    const f = pages(() => ({
      data: [{ id: '1' }],
      paging: { next: 'https://x/n' },
    }));
    expect((await list()).complete).toBe(false);
    expect(f).toHaveBeenCalledTimes(50);
  });
});
