import { describe, expect, it, vi } from 'vitest';

import { blockMediaPipeLogging } from './block-logging';

const LOG = 'https://odml.pa.googleapis.com/v1/log';

function target() {
  const real = vi.fn(function (this: unknown) {
    return Promise.resolve(new Response('real'));
  });
  return { real, t: { fetch: real as unknown as typeof fetch } };
}

describe('blockMediaPipeLogging', () => {
  it('answers the logging URL itself, in every input form', async () => {
    const { real, t } = target();
    blockMediaPipeLogging(t);
    for (const input of [LOG, new URL(LOG), new Request(LOG)]) {
      expect((await t.fetch(input)).status).toBe(403);
    }
    expect((await t.fetch(`${LOG}?key=x`, { method: 'POST' })).status).toBe(
      403
    );
    expect(real).not.toHaveBeenCalled();
  });

  it('passes everything else through, with the target as this', async () => {
    const { real, t } = target();
    blockMediaPipeLogging(t);
    const other = 'https://example.com/v1/log';
    const init = { method: 'POST' };
    for (const input of [other, new URL(other), new Request(other)]) {
      await t.fetch(input, init);
      expect(real).toHaveBeenLastCalledWith(input, init);
      expect(real.mock.contexts.at(-1)).toBe(t);
    }
  });

  it('wraps once', async () => {
    const { real, t } = target();
    blockMediaPipeLogging(t);
    const once = t.fetch;
    blockMediaPipeLogging(t);
    expect(t.fetch).toBe(once);
    await t.fetch('/api/x');
    expect(real).toHaveBeenCalledTimes(1);
  });
});
