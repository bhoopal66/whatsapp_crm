import { afterEach, describe, expect, it, vi } from 'vitest';

import { listMessageTemplates, MetaError } from './meta-api';

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

describe("Meta's refusal of a template", () => {
  const refused = async (error: object) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error }, { status: 400 }))
    );
    return (await list().catch((e: unknown) => e)) as MetaError;
  };

  it('carries the text written for the author', async () => {
    const err = await refused({
      message: 'Invalid parameter',
      code: 100,
      error_subcode: 2388299,
      error_user_title: 'Variables cannot be at the start or end',
      error_user_msg: 'Change the template and submit it again.',
    });
    expect(err).toBeInstanceOf(MetaError);
    expect(err.message).toBe(
      'Invalid parameter (Variables cannot be at the start or end: Change the template and submit it again.)'
    );
    expect(err.code).toBe(100);
    expect(err.subcode).toBe(2388299);
  });

  it('is the plain message when there is none', async () => {
    const err = await refused({ message: 'Invalid parameter', code: 100 });
    expect(err.message).toBe('Invalid parameter');
  });
});
