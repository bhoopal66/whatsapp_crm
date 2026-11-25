import { describe, expect, it, vi } from 'vitest';

import { MAX_READ_PAGES, READ_PAGE_SIZE, readPages } from './read-pages';

const full = () => Array.from({ length: READ_PAGE_SIZE }, (_, i) => i);

describe('readPages', () => {
  it('a short first page is one request and not truncated', async () => {
    const read = vi.fn(async () => ({ data: [1, 2, 3], error: null }));
    await expect(readPages(read)).resolves.toEqual({
      rows: [1, 2, 3],
      truncated: false,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(0, 999);
  });

  it('reads past 1,000 rows and stops on the short page', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ data: full(), error: null })
      .mockResolvedValueOnce({ data: [7], error: null });
    const out = await readPages(read);
    expect(out.rows).toHaveLength(READ_PAGE_SIZE + 1);
    expect(out.truncated).toBe(false);
    expect(read).toHaveBeenLastCalledWith(1000, 1999);
  });

  it('stops at the page cap and says it was cut', async () => {
    const read = vi.fn(async () => ({ data: full(), error: null }));
    const out = await readPages(read);
    expect(read).toHaveBeenCalledTimes(MAX_READ_PAGES);
    expect(out.rows).toHaveLength(MAX_READ_PAGES * READ_PAGE_SIZE);
    expect(out.truncated).toBe(true);
  });

  it('a failed page throws, never a partial figure', async () => {
    const boom = new Error('x');
    const read = vi
      .fn()
      .mockResolvedValueOnce({ data: full(), error: null })
      .mockResolvedValueOnce({ data: null, error: boom });
    await expect(readPages(read)).rejects.toBe(boom);
  });
});
