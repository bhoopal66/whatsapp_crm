// Ported from wacrm module 019a (assistant safety), reference package 2026-10-18 (test/019a/loop.test.ts):
// the pure LoopGuard tests, unchanged in substance. Canonical hashing and the risk rule are in canonical.test.ts and
// registry.test.ts.
import { describe, it, expect } from 'vitest';
import { LoopGuard, type Clock, type LoopDecision } from './loop';
import { ToolRegistry } from './registry';

const idOf = (d: LoopDecision): number => {
  if (!d.ok) throw new Error(`expected admit, got ${d.reason}`);
  return d.callId;
};

const fakeClock = () => {
  let t = 1_000_000;
  const c: Clock & { advance(ms: number): void } = {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
  return c;
};
describe('019a G8 LoopGuard', () => {
  it('refuses the 3rd identical call (LOOP_REPEAT); different args are not identical', () => {
    const g = new LoopGuard();
    expect(g.admit('r', { tool: 'get_contact', args: { id: 1 } }).ok).toBe(
      true
    );
    expect(g.admit('r', { tool: 'get_contact', args: { id: 1 } }).ok).toBe(
      true
    );
    expect(g.admit('r', { tool: 'get_contact', args: { id: 1 } })).toEqual({
      ok: false,
      reason: 'LOOP_REPEAT',
    });
    expect(g.admit('r', { tool: 'get_contact', args: { id: 2 } }).ok).toBe(
      true
    );
  });

  it('a batch of 20 parallel calls cannot exceed the cap (each counted before execution)', async () => {
    const g = new LoopGuard({ maxCalls: 8 });
    let executed = 0;
    const run = async (i: number) => {
      const d = g.admit('batch', { tool: 'search_contacts', args: { q: i } });
      if (!d.ok) return d.reason;
      await new Promise((r) => setTimeout(r, 5));
      executed++;
      return 'ok';
    };
    const out = await Promise.all(Array.from({ length: 20 }, (_, i) => run(i)));
    expect(executed).toBe(8);
    expect(out.filter((o) => o === 'CALL_CAP')).toHaveLength(12);
  });

  it('opens after K consecutive errors, half-opens on the injected clock with 1s, 5s, 30s backoff', () => {
    const clock = fakeClock();
    const g = new LoopGuard({ clock, maxCalls: 100 });
    const call = (i: number) => g.admit('c', { tool: 't', args: { i } });
    for (let i = 0; i < 3; i++) g.record('c', idOf(call(i)), 'error');
    expect(call(10)).toEqual({
      ok: false,
      reason: 'CIRCUIT_OPEN',
      retryAfterMs: 1_000,
    });
    clock.advance(999);
    expect(call(11).ok).toBe(false);
    clock.advance(1);
    const t1 = idOf(call(12)); // half-open trial
    expect(call(13)).toMatchObject({ ok: false, reason: 'CIRCUIT_OPEN' }); // only one trial
    g.record('c', t1, 'error'); // trial failed -> 5s
    expect(call(14)).toEqual({
      ok: false,
      reason: 'CIRCUIT_OPEN',
      retryAfterMs: 5_000,
    });
    clock.advance(5_000);
    g.record('c', idOf(call(15)), 'error'); // -> 30s
    expect(call(16)).toEqual({
      ok: false,
      reason: 'CIRCUIT_OPEN',
      retryAfterMs: 30_000,
    });
    clock.advance(30_000);
    g.record('c', idOf(call(17)), 'ok'); // closed
    expect(call(18).ok).toBe(true);
  });

  it('CALL_CAP ends a run while the breaker refuses every call; a trial in flight reports a real retryAfterMs', () => {
    const clock = fakeClock();
    const g = new LoopGuard({ clock, maxCalls: 8, maxIdentical: 3 });
    const call = (i: number) => g.admit('w', { tool: 't', args: { i } });
    for (let i = 0; i < 3; i++) g.record('w', idOf(call(i)), 'error');
    clock.advance(1_000);
    expect(call(3).ok).toBe(true); // call 4: half-open trial, never reported
    const refusals = [4, 5, 6, 7].map(call); // calls 5-8
    for (const r of refusals)
      expect(r).toEqual({
        ok: false,
        reason: 'CIRCUIT_OPEN',
        retryAfterMs: 1_000,
      });
    expect(call(8)).toEqual({ ok: false, reason: 'CALL_CAP' }); // the 9th attempt ends the run
  });

  it('stale outcome ignored: a call admitted before the last trip neither closes the breaker nor fails the trial', () => {
    const clock = fakeClock();
    const g = new LoopGuard({ clock, maxCalls: 100 });
    const call = (i: number) => g.admit('s', { tool: 't', args: { i } });
    const inFlight = [0, 1, 2, 3].map((i) => idOf(call(i))); // a parallel batch of four
    for (const id of inFlight.slice(0, 3)) g.record('s', id, 'error'); // three errors trip the breaker (1s)
    g.record('s', inFlight[3]!, 'ok'); // late ok from before the trip
    expect(call(10)).toEqual({
      ok: false,
      reason: 'CIRCUIT_OPEN',
      retryAfterMs: 1_000,
    }); // still open
    clock.advance(1_000);
    const trial = idOf(call(11));
    g.record('s', inFlight[3]!, 'error'); // late error from before the trip: not the trial failing
    expect(call(12)).toEqual({
      ok: false,
      reason: 'CIRCUIT_OPEN',
      retryAfterMs: 1_000,
    }); // trial still in flight, not re-opened at 5s
    g.record('s', trial, 'ok'); // the trial's own outcome closes it and resets trips
    expect(call(13).ok).toBe(true);
    for (let i = 20; i < 23; i++) g.record('s', idOf(call(i)), 'error');
    expect(call(30)).toEqual({
      ok: false,
      reason: 'CIRCUIT_OPEN',
      retryAfterMs: 1_000,
    }); // backoff restarted at step 1
  });

  it('state is per run and freed at run end', () => {
    const g = new LoopGuard({ maxCalls: 1 });
    expect(g.admit('a', { tool: 't', args: {} }).ok).toBe(true);
    expect(g.admit('a', { tool: 't', args: { x: 1 } })).toEqual({
      ok: false,
      reason: 'CALL_CAP',
    });
    expect(g.admit('b', { tool: 't', args: {} }).ok).toBe(true);
    expect(g.activeRuns).toBe(2);
    g.end('a');
    g.end('b');
    expect(g.activeRuns).toBe(0);
  });
});

describe('019a F8 loopKey', () => {
  it('loopKey: two calls differing only in an ignored arg count as identical (3rd refused)', () => {
    const reg = new ToolRegistry({
      send_message: {
        risk: 'WRITE',
        loopKey: (a) => ({
          to: (a as { to: string }).to,
          text: (a as { text: string }).text,
        }),
      },
    });
    const key = reg.spec('send_message').loopKey;
    const g = new LoopGuard();
    expect(
      g.admit(
        'r',
        {
          tool: 'send_message',
          args: { to: 'c1', text: 'hi', requestId: 'a' },
        },
        key
      ).ok
    ).toBe(true);
    expect(
      g.admit(
        'r',
        {
          tool: 'send_message',
          args: { to: 'c1', text: 'hi', requestId: 'b' },
        },
        key
      ).ok
    ).toBe(true);
    expect(
      g.admit(
        'r',
        {
          tool: 'send_message',
          args: { to: 'c1', text: 'hi', requestId: 'c' },
        },
        key
      )
    ).toEqual({ ok: false, reason: 'LOOP_REPEAT' });
    // without a loopKey the same three calls are distinct
    const h = new LoopGuard();
    for (const id of ['a', 'b', 'c'])
      expect(
        h.admit('r', {
          tool: 'send_message',
          args: { to: 'c1', text: 'hi', requestId: id },
        }).ok
      ).toBe(true);
  });
});
