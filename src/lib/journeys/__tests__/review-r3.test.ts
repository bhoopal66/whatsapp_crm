import { describe, expect, it } from 'vitest';
import {
  createRunner,
  drain,
  JourneyConflictError,
  newFile,
  type JourneyStore,
  type RunnerEvent,
} from '../index';
import { CONSENT_PORT, MemorySink, MemoryStore, def, dxb } from './helpers';

/** R3: commit (file + processed event + outbox) atomically, then deliver from the outbox. */
function harness() {
  const store = new MemoryStore(
      newFile({ id: 'f1', contactId: 'c1', workspaceId: 'w1' })
    ),
    sink = new MemorySink();
  return {
    store,
    sink,
    runner: createRunner({ def, store, sink, consent: CONSENT_PORT }),
  };
}
const hi: RunnerEvent = {
  id: 'wamid.hi',
  fileId: 'f1',
  type: 'INBOUND_TEXT',
  text: 'Hi',
  at: dxb(1, '10:00'),
};
const seqs = (s: MemorySink) => s.delivered.map((i) => i.seq);

describe('R3 runner outbox', () => {
  it('sink throws after commit → nothing after the failed item is delivered; next drain delivers welcome_menu exactly once', async () => {
    const h = harness();
    h.sink.fail = (i) =>
      i.action.type === 'SEND' && i.action.template === 'welcome_menu';
    const r = await h.runner.handle(hi);
    expect(r).toMatchObject({
      status: 'ok',
      drain: { delivered: 0, pending: 3 },
    });
    expect(h.store.files.get('f1')).toMatchObject({
      state: 'S_MENU',
      version: 1,
    });
    expect(h.sink.delivered).toEqual([]);
    expect(await h.runner.handle(hi)).toEqual({ status: 'duplicate' });
    expect(h.store.outbox).toHaveLength(3);
    h.sink.fail = () => false;
    expect(await h.runner.drain('f1')).toEqual({ delivered: 3, pending: 0 });
    expect(await h.runner.drain('f1')).toEqual({ delivered: 0, pending: 0 });
    expect(h.sink.sends()).toEqual(['welcome_menu']);
    expect(seqs(h.sink)).toEqual([1, 2, 3]);
  });

  it('SET_OPT_OUT is delivered after a failed first drain', async () => {
    const h = harness();
    await h.runner.handle(hi);
    let failures = 1;
    h.sink.fail = () => failures-- > 0;
    const r = await h.runner.handle({
      id: 'wamid.stop',
      fileId: 'f1',
      type: 'INBOUND_TEXT',
      text: 'STOP',
      at: dxb(1, '10:05'),
    });
    expect(r).toMatchObject({
      status: 'ok',
      drain: { delivered: 0, pending: 4 },
    });
    expect(h.sink.delivered.some((i) => i.action.type === 'SET_OPT_OUT')).toBe(
      false
    );
    expect(await h.runner.drain('f1')).toEqual({ delivered: 4, pending: 0 });
    expect(
      h.sink.delivered
        .filter((i) => i.action.type === 'SET_OPT_OUT')
        .map((i) => i.action)
    ).toEqual([{ type: 'SET_OPT_OUT', optedOut: true }]);
    expect(h.sink.sends()).toEqual(['welcome_menu', 'taamul_optout_confirm']);
  });

  it('concurrent handle() of the same event id → one commit, one delivery', async () => {
    const h = harness();
    const rs = await Promise.all([h.runner.handle(hi), h.runner.handle(hi)]);
    expect(rs.map((r) => r.status).sort()).toEqual(['duplicate', 'ok']);
    expect(h.store.commits).toBe(1);
    expect(h.store.outbox).toHaveLength(3);
    expect(h.sink.sends()).toEqual(['welcome_menu']);
    expect(h.sink.delivered).toHaveLength(3);
  });

  it('two different events racing on one file → version conflict, retry, both applied', async () => {
    const h = harness();
    await h.runner.handle(hi);
    const rs = await Promise.all([
      h.runner.handle({
        id: 'wamid.pos',
        fileId: 'f1',
        type: 'BUTTON',
        payload: 'POS',
        at: dxb(1, '10:01'),
      }),
      h.runner.handle({
        id: 'wamid.notnow',
        fileId: 'f1',
        type: 'BUTTON',
        payload: 'NOT_NOW',
        at: dxb(1, '10:02'),
      }),
    ]);
    expect(rs.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(h.store.conflicts).toBeGreaterThan(0);
    const f = h.store.files.get('f1')!;
    expect(f).toMatchObject({
      state: 'PARKED',
      prevOpenState: 'P_PITCH',
      version: 3,
    });
    expect(f.history.map((x) => `${x.from}→${x.to}`)).toEqual([
      'NEW→S_MENU',
      'S_MENU→P_PITCH',
      'P_PITCH→PARKED',
    ]);
    expect(seqs(h.sink)).toEqual(h.store.outbox.map((i) => i.seq));
    expect(h.store.outbox.every((i) => i.status === 'delivered')).toBe(true);
  });

  it('drain order follows seq, whatever order the store returns', async () => {
    const h = harness();
    h.sink.fail = () => true;
    await h.runner.handle(hi);
    h.sink.fail = () => false;
    const reversed: JourneyStore = Object.assign(
      Object.create(h.store) as MemoryStore,
      {
        pendingOutbox: async (id: string) =>
          (await h.store.pendingOutbox(id)).reverse(),
      }
    );
    expect(
      await drain(
        { store: reversed, sink: h.sink, consent: CONSENT_PORT },
        'f1'
      )
    ).toEqual({ delivered: 3, pending: 0 });
    expect(seqs(h.sink)).toEqual([1, 2, 3]);
    expect(h.sink.sends()).toEqual(['welcome_menu']);
  });

  it('a file that keeps changing → typed JourneyConflictError after the retries, nothing committed', async () => {
    const h = harness();
    h.store.commit = async () => 'conflict';
    await expect(h.runner.handle(hi)).rejects.toMatchObject({
      name: 'JourneyConflictError',
      fileId: 'f1',
      eventId: 'wamid.hi',
      attempts: 4,
    });
    await expect(h.runner.handle(hi)).rejects.toBeInstanceOf(
      JourneyConflictError
    );
    expect(h.sink.attempts).toBe(0);
  });
});
