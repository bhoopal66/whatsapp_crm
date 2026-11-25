import { describe, expect, it, vi } from 'vitest';

import { SecretIndex } from './secret-index';

type Row = { id: string; secret: string | null };

function index(rows: Row[] | null | (() => Row[] | null), clock = { t: 0 }) {
  const loadAll = vi.fn(async () =>
    typeof rows === 'function' ? rows() : rows
  );
  const idx = new SecretIndex<Row>({
    loadAll,
    idOf: (r) => r.id,
    secretOf: (r) => r.secret,
    ttlMs: 60_000,
    minReloadMs: 5_000,
    now: () => clock.t,
  });
  return { idx, loadAll, clock };
}

describe('SecretIndex', () => {
  it('finds a row and answers later hits from memory', async () => {
    const { idx, loadAll } = index([
      { id: 'a', secret: 's-a' },
      { id: 'b', secret: null },
    ]);
    expect(await idx.find('s-a')).toEqual({ failed: false, id: 'a' });
    expect(await idx.find('s-a')).toEqual({ failed: false, id: 'a' });
    expect(loadAll).toHaveBeenCalledTimes(1);
  });

  it('a flood of wrong secrets costs one reload per window', async () => {
    const { idx, loadAll, clock } = index([{ id: 'a', secret: 's-a' }]);
    for (let i = 0; i < 1000; i++) {
      clock.t = i; // within 1 s
      expect((await idx.find(`wrong-${i}`)).id).toBeNull();
    }
    expect(loadAll).toHaveBeenCalledTimes(1);
    clock.t = 6_000;
    await idx.find('wrong-again');
    expect(loadAll).toHaveBeenCalledTimes(2);
  });

  it('a new secret is found after the reload window, and the index ages out', async () => {
    const rows: Row[] = [{ id: 'a', secret: 's-a' }];
    const { idx, loadAll, clock } = index(() => rows);
    await idx.find('s-a');
    rows.push({ id: 'n', secret: 's-new' });
    clock.t = 1_000;
    expect((await idx.find('s-new')).id).toBeNull();
    clock.t = 5_000;
    expect((await idx.find('s-new')).id).toBe('n');
    clock.t = 70_000;
    await idx.find('s-a');
    expect(loadAll).toHaveBeenCalledTimes(3);
  });

  it('reports a failed first read, and keeps serving after a later one', async () => {
    let fail = true;
    const { idx, clock } = index(() =>
      fail ? null : [{ id: 'a', secret: 's' }]
    );
    expect(await idx.find('s')).toEqual({ failed: true, id: null });
    fail = false;
    clock.t = 5_000;
    expect(await idx.find('s')).toEqual({ failed: false, id: 'a' });
    fail = true;
    clock.t = 70_000;
    expect(await idx.find('s')).toEqual({ failed: false, id: 'a' });
  });

  it('skips a row whose secret cannot be read, and shares one reload', async () => {
    const loadAll = vi.fn(async () => [
      { id: 'bad', secret: 'x' },
      { id: 'ok', secret: 'y' },
    ]);
    const idx = new SecretIndex<Row>({
      loadAll,
      idOf: (r) => r.id,
      secretOf: (r) => {
        if (r.id === 'bad') throw new Error('rotated key');
        return r.secret;
      },
    });
    const [a, b] = await Promise.all([idx.find('y'), idx.find('y')]);
    expect(a.id).toBe('ok');
    expect(b.id).toBe('ok');
    expect(loadAll).toHaveBeenCalledTimes(1);
    expect((await idx.find('')).id).toBeNull();
  });

  it('finds a new secret at once after a save (invalidate)', async () => {
    const rows: Row[] = [{ id: 'a', secret: 's-a' }];
    const { idx, clock } = index(() => [...rows]);
    await idx.find('s-a');
    rows[0] = { id: 'a', secret: 's-new' };
    clock.t = 1_000;
    expect((await idx.find('s-new')).id).toBeNull();
    idx.invalidate();
    expect((await idx.find('s-new')).id).toBe('a');
    expect((await idx.find('s-a')).id).toBeNull();
  });

  it('a read started before the save is not kept', async () => {
    let rows: Row[] = [{ id: 'a', secret: 'old' }];
    const release: Array<() => void> = [];
    const idx = new SecretIndex<Row>({
      loadAll: async () => {
        const seen = rows;
        await new Promise<void>((r) => release.push(r));
        return seen;
      },
      idOf: (r) => r.id,
      secretOf: (r) => r.secret,
    });
    const first = idx.find('new');
    rows = [{ id: 'a', secret: 'new' }];
    idx.invalidate();
    release[0]!();
    await vi.waitFor(() => expect(release.length).toBe(2));
    release[1]!();
    expect(await first).toEqual({ failed: false, id: 'a' });
  });

  it('a slow read from before the save does not replace the fresh one', async () => {
    let rows: Row[] = [{ id: 'a', secret: 'old' }];
    const release: Array<() => void> = [];
    const idx = new SecretIndex<Row>({
      loadAll: async () => {
        const seen = rows;
        await new Promise<void>((r) => release.push(r));
        return seen;
      },
      idOf: (r) => r.id,
      secretOf: (r) => r.secret,
      now: () => 0,
    });
    const slow = idx.find('other');
    rows = [{ id: 'a', secret: 'new' }];
    idx.invalidate();
    const fresh = idx.find('new');
    await vi.waitFor(() => expect(release.length).toBe(2));
    release[1]!();
    expect((await fresh).id).toBe('a');
    release[0]!();
    expect((await slow).id).toBeNull();
    expect((await idx.find('new')).id).toBe('a');
    expect(release.length).toBe(2);
  });

  it('an unknown secret while the last read failed is failed, not unknown', async () => {
    let fail = false;
    const { idx, clock } = index(() =>
      fail ? null : [{ id: 'a', secret: 's' }]
    );
    await idx.find('s');
    fail = true;
    clock.t = 10_000;
    expect(await idx.find('brand-new')).toEqual({ failed: true, id: null });
    clock.t = 11_000;
    expect(await idx.find('brand-new')).toEqual({ failed: true, id: null });
    expect(await idx.find('s')).toEqual({ failed: false, id: 'a' });
  });
});
