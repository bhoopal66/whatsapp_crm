import { describe, expect, it } from 'vitest';

import { readTextCapped } from './read-capped';

const url = 'https://crm.example.com/hook';

describe('readTextCapped', () => {
  it('returns the exact text of a body within the cap', async () => {
    const text = '{"a":"é"}';
    const req = new Request(url, { method: 'POST', body: text });
    expect(await readTextCapped(req, 100)).toBe(text);
    const exact = new Request(url, { method: 'POST', body: 'abcd' });
    expect(await readTextCapped(exact, 4)).toBe('abcd');
  });

  it('returns an empty string for no body', async () => {
    expect(await readTextCapped(new Request(url, { method: 'POST' }), 10)).toBe(
      ''
    );
  });

  it('refuses a declared length over the cap without reading', async () => {
    const body = new ReadableStream<Uint8Array>();
    const req = new Request(url, {
      method: 'POST',
      body,
      headers: { 'content-length': '11' },
      duplex: 'half',
    } as RequestInit);
    expect(await readTextCapped(req, 10)).toBeNull();
    expect(req.body?.locked).toBe(false);
  });

  it('cuts off a streamed body that grows past the cap, and stops reading', async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(4));
      },
    });
    const req = new Request(url, {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);
    expect(await readTextCapped(req, 10)).toBeNull();
    expect(pulls).toBeLessThan(10);
  });
});
