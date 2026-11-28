import { describe, expect, it, vi } from 'vitest';

import {
  cardErrorKey,
  confirmCard,
  dismissCard,
  type PendingCard,
} from './client';

const CHAT = '44444444-4444-4444-8444-444444444444';
const card: PendingCard = {
  status: 'pending',
  pendingId: '33333333-3333-4333-8333-333333333333',
  nonce: 'abcdef0123456789abcd',
  tool: 'chat_add_note',
  args: { conversationId: CHAT, body: 'x' },
  view: { kind: 'note', body: 'x' },
  why: '',
};

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

describe('the card confirmation flow', () => {
  it('confirms, then runs exactly what the card carried', async () => {
    const f = vi.fn<Fetcher>(async () => reply(200, { ok: true }));
    expect(await confirmCard(CHAT, card, f)).toEqual({ ok: true });
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      `/api/assist/pending/${card.pendingId}`,
      `/api/assist/chat/${CHAT}/run`,
    ]);
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({
      decision: 'confirm',
      nonce: card.nonce,
    });
    expect(JSON.parse(String(f.mock.calls[1][1]?.body))).toEqual({
      pendingId: card.pendingId,
      tool: card.tool,
      args: card.args,
    });
  });

  it('never runs when the confirmation is refused', async () => {
    const f = vi.fn(async () => reply(409, { error: 'EXPIRED' }));
    expect(await confirmCard(CHAT, card, f)).toEqual({
      ok: false,
      step: 'confirm',
      code: 'EXPIRED',
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('reports a refused run', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(reply(200, { ok: true }))
      .mockResolvedValueOnce(reply(409, { code: 'refused' }));
    expect(await confirmCard(CHAT, card, f)).toEqual({
      ok: false,
      step: 'run',
      code: 'refused',
    });
  });

  it('a network failure is a failure, not a success', async () => {
    const f = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await confirmCard(CHAT, card, f)).toEqual({
      ok: false,
      step: 'confirm',
      code: 'network',
    });
  });

  it('dismiss denies the pending action and never runs it', async () => {
    const f = vi.fn<Fetcher>(async () => reply(200));
    await dismissCard(card, f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(f.mock.calls[0][1]?.body)).decision).toBe('deny');
  });

  it('words each refusal', () => {
    expect(cardErrorKey('EXPIRED')).toBe('expired');
    expect(cardErrorKey('HASH_MISMATCH')).toBe('changed');
    expect(cardErrorKey('PENDING_CAP')).toBe('busy');
    expect(cardErrorKey('whatever')).toBe('failed');
  });
});
