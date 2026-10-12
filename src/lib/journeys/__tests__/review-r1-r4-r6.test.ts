import { describe, expect, it } from 'vitest';
import { step, type JourneyEvent } from '../index';
import { CONSENT, Sim, adv, clone, def, dxb, inb, posToDocs } from './helpers';

const timer = (kind: string, at: string): JourneyEvent => ({
  type: 'TIMER',
  kind,
  at,
});

describe('R1 stale / early timers', () => {
  it('stale MENU_SILENCE after a day-30 inbound does not re-engage (STALE_TIMER)', () => {
    const sim = new Sim(def, CONSENT).ev(
      inb(dxb(1, '10:00')),
      inb(dxb(30, '09:00'))
    );
    expect(sim.file.timers.find((t) => t.kind === 'MENU_SILENCE')!.fireAt).toBe(
      new Date(Date.parse(dxb(30, '09:00')) + 30 * 86_400_000).toISOString()
    );
    const r = step(
      def,
      sim.file,
      timer('MENU_SILENCE', dxb(31, '10:00')),
      dxb(31, '10:00'),
      CONSENT
    );
    expect(r.file.state).toBe('S_MENU');
    expect(r.actions.filter((a) => a.type === 'SEND')).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(['STALE_TIMER']);
  });
  it('re-arm on inbound emits CANCEL_TIMERS {kinds} before SET_TIMER of the same kind', () => {
    const sim = new Sim(def, CONSENT).ev(inb(dxb(1, '10:00')));
    const r = step(
      def,
      sim.file,
      inb(dxb(1, '12:00')),
      dxb(1, '12:00'),
      CONSENT
    );
    const i = r.actions.findIndex(
      (a) =>
        a.type === 'CANCEL_TIMERS' &&
        'kinds' in a &&
        a.kinds[0] === 'MENU_SILENCE'
    );
    const j = r.actions.findIndex(
      (a) => a.type === 'SET_TIMER' && a.kind === 'MENU_SILENCE'
    );
    expect(i).toBeGreaterThanOrEqual(0);
    expect(j).toBeGreaterThan(i);
  });
  it('old DOCS_REMINDER_1 firing after DOCS re-entry does not send an early reminder', () => {
    const sim = posToDocs(new Sim()).ev(
      adv('DOCS_COMPLETE', dxb(2, '10:00')),
      adv('PARTNER_MORE_INFO', dxb(3, '10:00'))
    );
    const r = step(
      def,
      sim.file,
      timer('DOCS_REMINDER_1', dxb(4, '16:02')),
      dxb(4, '16:02'),
      CONSENT
    );
    expect(r.actions.filter((a) => a.type === 'SEND')).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(['STALE_TIMER']);
    expect(r.file.counters.remindersThisStage).toBe(0);
  });
});

describe('R4 out-of-order inbound', () => {
  it('an older inbound does not move lastInboundAt backwards', () => {
    const sim = new Sim(def, CONSENT).ev(
      inb(dxb(1, '10:00')),
      inb(dxb(2, '10:00'))
    );
    const r = step(
      def,
      sim.file,
      inb(dxb(1, '11:00')),
      dxb(2, '10:01'),
      CONSENT
    );
    expect(r.file.window.lastInboundAt).toBe(dxb(2, '10:00'));
  });
});

describe('R6 quiet-hours deferral bills at notBefore', () => {
  it('free-entry window ending between timer time and notBefore → deferred MARKETING send is billable', () => {
    const d = clone();
    d.states.S_MENU!.timers![1]!.after = '69h';
    const sim = new Sim(d, CONSENT)
      .ev(inb(dxb(1, '02:00'), 'Hi', true))
      .runUntil(dxb(4, '12:00'));
    const re = sim.sends().find((s) => s.template === 'taamul_reengage_30d')!;
    expect(re).toMatchObject({
      at: dxb(3, '23:00'),
      notBefore: dxb(4, '09:00'),
      billable: true,
    });
    expect(sim.log.map((x) => x.action)).toContainEqual({
      type: 'LOG_COST',
      template: 'taamul_reengage_30d',
      category: 'MARKETING',
    });
  });
});
