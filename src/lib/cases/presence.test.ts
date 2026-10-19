/**
 * 018c C2b presence banner (src/case/presence.ts CasePresence): best effort, UI hint only.
 *   - an entry expires after the 30 s TTL (injected clock); 29.999 s still shown, 30 s gone;
 *   - others() excludes the asker; touch() again updates the state;
 *   - touch() records nothing when the canRead predicate refuses;
 *   - bounded: expired entries are swept; per-case and global caps drop the oldest first.
 */
import { describe, it, expect } from 'vitest';
import { CasePresence, PRESENCE_TTL_MS } from './presence';

function clock(start = Date.UTC(2026, 9, 18, 9, 0, 0)) {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}
const anyone = () => true;
const ids = (p: CasePresence, caseId: string, asker = 'nobody') =>
  p.others(caseId, { userId: asker }).map((e) => e.userId);

describe('018c C2b case presence', () => {
  it('TTL is 30 s: shown at 29.999 s, gone at 30 s', async () => {
    expect(PRESENCE_TTL_MS).toBe(30_000);
    const c = clock();
    const p = new CasePresence({ canRead: anyone, now: c.now });
    await p.touch('k1', { userId: 'lead1' }, 'viewing');
    c.advance(29_999);
    expect(ids(p, 'k1')).toEqual(['lead1']);
    c.advance(1);
    expect(ids(p, 'k1')).toEqual([]);
  });

  it('excludes the asker; a second touch updates the state and refreshes the TTL', async () => {
    const c = clock();
    const p = new CasePresence({ canRead: anyone, now: c.now });
    await p.touch('k1', { userId: 'agentA' }, 'viewing');
    await p.touch('k1', { userId: 'lead1' }, 'viewing');
    expect(ids(p, 'k1', 'agentA')).toEqual(['lead1']);
    expect(ids(p, 'k1', 'lead1')).toEqual(['agentA']);
    c.advance(20_000);
    await p.touch('k1', { userId: 'lead1' }, 'typing');
    c.advance(15_000); // agentA's entry is 35 s old, lead1's 15 s
    expect(p.others('k1', { userId: 'agentA' })).toEqual([
      {
        userId: 'lead1',
        state: 'typing',
        at: new Date(Date.UTC(2026, 9, 18, 9, 0, 20)),
      },
    ]);
    expect(ids(p, 'k1', 'lead1')).toEqual([]);
    expect(ids(p, 'k2', 'lead1')).toEqual([]);
  });

  it('touch records nothing when canRead refuses (sync or async predicate)', async () => {
    const seen: [string, string][] = [];
    const p = new CasePresence({
      canRead: async (caseId, userId) => {
        seen.push([caseId, userId]);
        return userId !== 'agentB';
      },
      now: clock().now,
    });
    expect(await p.touch('k1', { userId: 'agentB' }, 'typing')).toBe(false);
    expect(await p.touch('k1', { userId: 'agentA' }, 'viewing')).toBe(true);
    expect(seen).toEqual([
      ['k1', 'agentB'],
      ['k1', 'agentA'],
    ]);
    expect(ids(p, 'k1')).toEqual(['agentA']);
    expect(p.size()).toBe(1);
    const sync = new CasePresence({ canRead: () => false, now: clock().now });
    expect(await sync.touch('k1', { userId: 'adm' }, 'viewing')).toBe(false);
    expect(sync.size()).toBe(0);
  });

  it('bounded: expired entries are swept on touch; the per-case and global caps drop the oldest first', async () => {
    const c = clock();
    const swept = new CasePresence({ canRead: anyone, now: c.now });
    for (let i = 0; i < 50; i++)
      await swept.touch(`case-${i}`, { userId: 'u' }, 'viewing');
    expect(swept.size()).toBe(50);
    c.advance(30_000);
    await swept.touch('fresh', { userId: 'u' }, 'viewing');
    expect(swept.size()).toBe(1);

    const perCase = new CasePresence({
      canRead: anyone,
      now: c.now,
      maxPerCase: 3,
      maxTotal: 100,
    });
    for (const u of ['a', 'b', 'c', 'd', 'e']) {
      await perCase.touch('k1', { userId: u }, 'viewing');
      c.advance(10);
    }
    expect(ids(perCase, 'k1')).toEqual(['c', 'd', 'e']);
    expect(perCase.size()).toBe(3);

    const global = new CasePresence({
      canRead: anyone,
      now: c.now,
      maxPerCase: 10,
      maxTotal: 4,
    });
    for (const [k, u] of [
      ['k1', 'a'],
      ['k2', 'b'],
      ['k1', 'c'],
      ['k3', 'd'],
      ['k2', 'e'],
      ['k4', 'f'],
    ] as const) {
      await global.touch(k, { userId: u }, 'viewing');
      c.advance(10);
    }
    expect(global.size()).toBe(4);
    expect([
      ids(global, 'k1'),
      ids(global, 'k2'),
      ids(global, 'k3'),
      ids(global, 'k4'),
    ]).toEqual([['c'], ['e'], ['d'], ['f']]);
  });
});
