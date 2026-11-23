import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPreferenceSaver } from './preference-saver';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

function setup() {
  const sent: { body: string; keepalive: boolean; done: () => void }[] = [];
  const saver = createPreferenceSaver<string>({
    delayMs: 600,
    send: (body, { keepalive }) =>
      new Promise((done) => sent.push({ body, keepalive, done })),
  });
  return { sent, saver, bodies: () => sent.map((s) => s.body) };
}

describe('createPreferenceSaver', () => {
  it('saves the latest change once, after the pause', async () => {
    const f = setup();
    f.saver.schedule('a');
    f.saver.schedule('b');
    await vi.advanceTimersByTimeAsync(599);
    expect(f.bodies()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.bodies()).toEqual(['b']);
    expect(f.sent[0].keepalive).toBe(false);
  });

  it('sends what is waiting when the panel closes inside the pause', async () => {
    const f = setup();
    f.saver.schedule('a');
    f.saver.flush();
    expect(f.sent).toMatchObject([{ body: 'a', keepalive: true }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.sent).toHaveLength(1);
  });

  it('never has two saves under way: the latest follows the first', async () => {
    const f = setup();
    f.saver.schedule('a');
    await vi.advanceTimersByTimeAsync(600);
    f.saver.schedule('b');
    await vi.advanceTimersByTimeAsync(600);
    f.saver.schedule('c');
    f.saver.flush();
    expect(f.bodies()).toEqual(['a']);
    f.sent[0].done();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.bodies()).toEqual(['a', 'c']);
    expect(f.sent[1].keepalive).toBe(true);
    f.sent[1].done();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.sent).toHaveLength(2);
  });

  it('does not wait for a save under way when the page itself closes', async () => {
    const f = setup();
    f.saver.schedule('a');
    await vi.advanceTimersByTimeAsync(600);
    f.saver.schedule('b');
    f.saver.flushNow();
    expect(f.sent[1]).toMatchObject({ body: 'b', keepalive: true });
  });

  it('closing with nothing waiting sends nothing', () => {
    const f = setup();
    f.saver.flush();
    f.saver.flushNow();
    expect(f.sent).toEqual([]);
  });
});
