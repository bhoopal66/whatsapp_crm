import { describe, it, expect } from 'vitest';
import {
  CLAIM_LEASE_SECONDS,
  MemorySeenStore,
  ReplayGuard,
  REPLAY_TTL_SECONDS,
} from '../replay';

describe('ReplayGuard (memory)', () => {
  it('claim → new with token; again → inflight; after confirm → done; keys are independent', async () => {
    const g = new ReplayGuard(new MemorySeenStore());
    const c = await g.claim('msg:a');
    expect(c).toEqual({ state: 'new', token: expect.any(String) });
    expect(await g.claim('msg:a')).toEqual({ state: 'inflight' });
    expect(await g.confirm('msg:a', c.token!)).toBe(true);
    expect(await g.claim('msg:a')).toEqual({ state: 'done' });
    expect((await g.claim('msg:b')).state).toBe('new');
  });

  it('wrong token cannot confirm', async () => {
    const g = new ReplayGuard(new MemorySeenStore());
    const c = await g.claim('msg:w');
    expect(await g.confirm('msg:w', 'not-the-token')).toBe(false);
    expect(await g.claim('msg:w')).toEqual({ state: 'inflight' });
    expect(await g.confirm('msg:w', c.token!)).toBe(true);
  });

  it('an unconfirmed claim lapses after its 60s lease; a confirmation lasts 24h (injected clock)', async () => {
    let t = 1_000_000;
    const store = new MemorySeenStore(() => t);
    const g = new ReplayGuard(store);
    expect(CLAIM_LEASE_SECONDS).toBe(60);
    expect(REPLAY_TTL_SECONDS).toBe(86_400);
    const lost = await g.claim('k');
    t += 60_000 - 1;
    expect((await g.claim('k')).state).toBe('inflight');
    t += 1;
    const c = await g.claim('k');
    expect(c.state).toBe('new');
    expect(await g.confirm('k', lost.token!)).toBe(false); // the lapsed claim lost the key
    expect(await g.confirm('k', c.token!)).toBe(true);
    t += 86_400_000 - 1;
    expect((await g.claim('k')).state).toBe('done');
    t += 1;
    expect((await g.claim('k')).state).toBe('new');
    t += 60_000;
    expect(store.purge()).toBe(1);
    expect(store.size).toBe(0);
  });
});

describe('ReplayGuard.release (memory)', () => {
  it('frees only the current unconfirmed claim', async () => {
    const g = new ReplayGuard(new MemorySeenStore());
    const c = await g.claim('k');
    expect(await g.release('k', 'wrong')).toBe(false);
    expect(await g.release('k', c.token!)).toBe(true);
    const c2 = await g.claim('k');
    expect(c2.state).toBe('new');
    await g.confirm('k', c2.token!);
    expect(await g.release('k', c2.token!)).toBe(false);
    expect((await g.claim('k')).state).toBe('done');
  });
});
