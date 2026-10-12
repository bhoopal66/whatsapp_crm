import { describe, expect, it } from 'vitest';
import {
  createRunner,
  newFile,
  step,
  type JourneyEvent,
  type JourneyFile,
  type RunnerEvent,
} from '../index';
import {
  CONSENT,
  CONSENT_PORT,
  MemorySink,
  MemoryStore,
  Sim,
  adv,
  btn,
  clone,
  deepFreeze,
  def,
  dxb,
  inb,
  posToDocs,
} from './helpers';

describe('ADVISOR CLOSE', () => {
  const file = new Sim().ev(inb(dxb(1, '10:00'))).file;
  it('without reasonCode is rejected with an error and no change', () => {
    for (const ev of [
      adv('CLOSE', dxb(1, '11:00')),
      adv('CLOSE', dxb(1, '11:00'), { reasonCode: '  ' }),
    ]) {
      const r = step(def, file, ev, dxb(1, '11:00'), CONSENT);
      expect(r.error?.code).toBe('REASON_REQUIRED');
      expect(r.file).toBe(file);
      expect(r.actions).toEqual([]);
    }
  });
  it('with reasonCode closes CLOSED_ADVISOR carrying the code', () => {
    const r = step(
      def,
      file,
      adv('CLOSE', dxb(1, '11:00'), { reasonCode: 'DUPLICATE_LEAD' }),
      dxb(1, '11:00'),
      CONSENT
    );
    expect(r.file).toMatchObject({
      state: 'CLOSED_ADVISOR',
      outcome: { kind: 'NOT_WON', reason: 'DUPLICATE_LEAD' },
    });
    expect(r.actions).toContainEqual({
      type: 'CLOSE',
      outcome: 'NOT_WON',
      reason: 'DUPLICATE_LEAD',
    });
  });
});

describe('send policy', () => {
  it('SESSION message outside the window becomes an advisor task, not a send', () => {
    const d = clone();
    d.states.S_MENU!.timers![1]!.then = { setProduct: 'POS', to: 'P_PITCH' };
    d.states.P_PITCH!.onEnter = { send: [{ template: 'pos_pitch_in_window' }] };
    const sim = new Sim(d).ev(inb(dxb(1, '10:00'))).runUntil(dxb(31, '12:00'));
    expect(sim.file.state).toBe('P_PITCH');
    expect(sim.sends().map((s) => s.template)).toEqual(['welcome_menu']);
    expect(sim.log.map((x) => x.action)).toContainEqual({
      type: 'ADVISOR_TASK',
      kind: 'TEMPLATE_NEEDED',
      dueAt: dxb(31, '10:00'),
      note: 'window closed — template needed (session message pos_pitch_in_window)',
    });
  });
  it('20h menu nudge is an advisor task (never an auto-send)', () => {
    const sim = new Sim().ev(inb(dxb(1, '10:00'))).runUntil(dxb(2, '07:00'));
    expect(sim.tasks()).toEqual(['ADVISOR_NUDGE']);
    expect(sim.sends()).toHaveLength(1);
  });
});

describe('determinism and purity', () => {
  it('same inputs → deep-equal outputs; deep-frozen inputs are not mutated', () => {
    const base = posToDocs(new Sim()).file;
    const events: JourneyEvent[] = [
      inb(dxb(2, '09:00')),
      btn('NEED_MORE_TIME', dxb(2, '09:01')),
      adv('DOCS_COMPLETE', dxb(2, '09:02')),
      { type: 'TIMER', kind: 'DOCS_REMINDER_1', at: dxb(4, '16:02') },
      { type: 'MEDIA', count: 2, at: dxb(2, '09:03') },
      inb(dxb(2, '09:04'), 'STOP'),
      adv('CLOSE', dxb(2, '09:05')),
    ];
    const fDef = deepFreeze(clone()),
      fFile = deepFreeze(structuredClone(base)),
      ctx = deepFreeze(structuredClone(CONSENT));
    for (const e of events) {
      const ev = deepFreeze(structuredClone(e));
      const a = step(fDef, fFile, ev, e.at, ctx),
        b = step(fDef, fFile, ev, e.at, ctx);
      expect(a).toEqual(b);
      expect(fFile).toEqual(base);
    }
  });
});

describe('runner', () => {
  function harness(file: JourneyFile) {
    const store = new MemoryStore(file),
      sink = new MemorySink();
    return {
      store,
      sink,
      runner: createRunner({ def, store, sink, consent: CONSENT_PORT }),
    };
  }
  it('same event id twice → second is a no-op', async () => {
    const h = harness(
      newFile({ id: 'f1', contactId: 'c1', workspaceId: 'w1' })
    );
    const ev: RunnerEvent = {
      id: 'wamid.1',
      fileId: 'f1',
      type: 'INBOUND_TEXT',
      text: 'Hi',
      at: dxb(1, '10:00'),
    };
    expect((await h.runner.handle(ev)).status).toBe('ok');
    const after = structuredClone(h.store.files.get('f1'));
    expect(await h.runner.handle(ev)).toEqual({ status: 'duplicate' });
    expect(h.store.files.get('f1')).toEqual(after);
    expect(h.sink.sends()).toEqual(['welcome_menu']);
    expect(h.store.commits).toBe(1);
  });
  it('rejected event is neither persisted nor marked processed', async () => {
    const h = harness(new Sim().ev(inb(dxb(1, '10:00'))).file);
    const ev: RunnerEvent = {
      id: 'e2',
      fileId: 'f1',
      type: 'ADVISOR',
      decision: 'CLOSE',
      at: dxb(1, '11:00'),
      by: 'a1',
    };
    expect((await h.runner.handle(ev)).status).toBe('rejected');
    expect(h.store.commits).toBe(0);
    expect(h.store.outbox).toEqual([]);
    expect(
      (await h.runner.handle({ ...ev, reasonCode: 'DUPLICATE_LEAD' })).status
    ).toBe('ok');
  });
});
