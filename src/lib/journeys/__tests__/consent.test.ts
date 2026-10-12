import { describe, expect, it } from 'vitest';
import { newFile, step } from '../index';
import { CONSENT, NO_CONSENT, Sim, btn, ctxOf, def, dxb, inb } from './helpers';

describe('inbound lead and marketing consent (D-016-2)', () => {
  it('no consent: 30-day silence → CLOSED_NO_RESPONSE directly, no MARKETING and no paid send', () => {
    const sim = new Sim(def, NO_CONSENT)
      .ev(inb(dxb(1, '10:00')))
      .runUntil(dxb(40, '10:00'));
    expect(sim.file.state).toBe('CLOSED_NO_RESPONSE');
    expect(sim.file.history.at(-1)).toMatchObject({
      from: 'S_MENU',
      to: 'CLOSED_NO_RESPONSE',
    });
    expect(sim.file.outcome).toEqual({
      kind: 'NOT_WON',
      reason: 'NO_RESPONSE',
    });
    expect(sim.sends().map((s) => s.template)).toEqual(['welcome_menu']);
    expect(
      sim.sends().some((s) => s.billable || s.category === 'MARKETING')
    ).toBe(false);
  });
  it('no consent: parked lead is closed, not re-engaged', () => {
    const sim = new Sim(def, NO_CONSENT)
      .ev(
        inb(dxb(1, '10:00')),
        btn('POS', dxb(1, '10:01')),
        btn('NOT_NOW', dxb(1, '10:02'))
      )
      .runUntil(dxb(40, '10:00'));
    expect(sim.file.state).toBe('CLOSED_NO_RESPONSE');
    expect(sim.sends().some((s) => s.category === 'MARKETING')).toBe(false);
  });
  it('with consent: 30-day silence → one MARKETING re-engage (paid)', () => {
    const sim = new Sim(def, CONSENT)
      .ev(inb(dxb(1, '10:00')))
      .runUntil(dxb(31, '12:00'));
    expect(sim.file.state).toBe('RE_ENGAGE');
    expect(sim.sends().at(-1)).toMatchObject({
      template: 'taamul_reengage_30d',
      category: 'MARKETING',
      billable: true,
    });
  });
});

describe('cold START', () => {
  const f = newFile({ id: 'f1', contactId: 'c1', workspaceId: 'w1' });
  const ev = { type: 'START_COLD', at: dxb(1, '10:00') } as const;
  it('refused without consent or when opted out', () => {
    for (const ctx of [NO_CONSENT, ctxOf(true, true)]) {
      const r = step(def, f, ev, ev.at, ctx);
      expect(r.warnings.map((w) => w.code)).toEqual(['NO_CONSENT']);
      expect(r.actions).toEqual([]);
      expect(r.file.state).toBe('NEW');
    }
  });
  it('with consent: exactly one paid MARKETING send', () => {
    const r = step(def, f, ev, ev.at, CONSENT);
    expect(r.file.state).toBe('S_MENU');
    expect(r.file.entry).toBe('COLD');
    const sends = r.actions.filter((a) => a.type === 'SEND');
    expect(sends).toEqual([
      {
        type: 'SEND',
        template: 'taamul_optin_welcome',
        category: 'MARKETING',
        billable: true,
      },
    ]);
  });
  it('second START for the same contact is refused (once per contact)', () => {
    const r = step(
      def,
      newFile({ id: 'f2', contactId: 'c1', workspaceId: 'w1' }),
      ev,
      ev.at,
      ctxOf(true, false, true)
    );
    expect(r.warnings.map((w) => w.code)).toEqual(['CAP_REACHED']);
    expect(r.actions).toEqual([]);
    const again = step(
      def,
      step(def, f, ev, ev.at, CONSENT).file,
      ev,
      ev.at,
      CONSENT
    );
    expect(again.warnings.map((w) => w.code)).toEqual(['ALREADY_STARTED']);
  });
});

describe('re-engagement', () => {
  const parked = () =>
    new Sim(def, CONSENT).ev(
      inb(dxb(1, '10:00')),
      btn('POS', dxb(1, '10:01')),
      btn('NOT_NOW', dxb(1, '10:02'))
    );
  it('PARKED keeps prevOpenState; re-engage once; YES_CONTINUE returns there', () => {
    const sim = parked();
    expect(sim.file).toMatchObject({
      state: 'PARKED',
      prevOpenState: 'P_PITCH',
      outcome: { kind: 'PARKED', reason: 'NOT_NOW' },
    });
    sim.runUntil(dxb(31, '12:00'));
    expect(sim.file.state).toBe('RE_ENGAGE');
    sim.ev(btn('YES_CONTINUE', dxb(32, '10:00')));
    expect(sim.file).toMatchObject({
      state: 'P_PITCH',
      outcome: null,
      prevOpenState: null,
    });
    sim.runUntil(dxb(70, '10:00'));
    expect(sim.file.state).toBe('CLOSED_NO_RESPONSE');
    expect(
      sim.sends().filter((s) => s.template === 'taamul_reengage_30d')
    ).toHaveLength(1);
    expect(sim.warnings.map((w) => w.code)).toContain('CAP_REACHED');
  });
  it('7 days of silence after re-engage closes with reason', () => {
    const sim = parked().runUntil(dxb(45, '10:00'));
    expect(sim.file.state).toBe('CLOSED_NO_RESPONSE');
    expect(sim.file.history.at(-1)).toMatchObject({
      from: 'RE_ENGAGE',
      cause: 'TIMER:REENGAGE_SILENCE',
    });
    expect(
      sim.log.map((x) => x.action).filter((a) => a.type === 'CLOSE')
    ).toEqual([{ type: 'CLOSE', outcome: 'NOT_WON', reason: 'NO_RESPONSE' }]);
  });
});
