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
});
