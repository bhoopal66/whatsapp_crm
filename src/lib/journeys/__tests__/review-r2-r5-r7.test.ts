import { describe, expect, it } from 'vitest';
import { step, validateWorkflow } from '../index';
import {
  CONSENT,
  NO_CONSENT,
  Sim,
  adv,
  btn,
  clone,
  def,
  dxb,
  inb,
  posToDocs,
} from './helpers';

/** POS lead to P_DECIDE with a quote valid until `until`. */
const toDecide = (sim: Sim, until: string) =>
  sim.ev(
    inb(dxb(1, '10:00')),
    btn('POS', dxb(1, '10:01')),
    btn('QUOTE', dxb(1, '10:02')),
    adv('QUOTE_READY', dxb(1, '11:00'), { validUntil: until })
  );
/** States entered after the lapse, each with the cause that moved the file there. */
const after = (sim: Sim, from: number) =>
  sim.file.history.slice(from).map((h) => `${h.to}<-${h.cause}`);

describe('R2 a lapsed quote/offer needs an advisor re-issue', () => {
  it('(a) OFFER_EXPIRY → PARKED: CONFIRM twice stays PARKED with re-issue tasks; FULFILMENT_SCHEDULED re-issues', () => {
    const sim = posToDocs(new Sim())
      .ev(
        adv('DOCS_COMPLETE', dxb(2, '10:00')),
        adv('PARTNER_APPROVED', dxb(3, '10:00')),
        adv('FULFILMENT_SCHEDULED', dxb(3, '11:00'), {
          validUntil: dxb(5, '11:00'),
        })
      )
      .runUntil(dxb(5, '12:00'));
    expect(sim.file).toMatchObject({
      state: 'PARKED',
      prevOpenState: 'FULFILMENT',
      outcome: { reason: 'VALIDITY_LAPSED' },
    });
    const h = sim.file.history.length;
    sim.ev(btn('CONFIRM', dxb(6, '10:00')), btn('CONFIRM', dxb(6, '10:01')));
    expect(sim.file.state).toBe('PARKED');
    expect(after(sim, h)).toEqual([]);
    expect(sim.tasks().filter((k) => k === 'REISSUE_OFFER')).toHaveLength(2);
    sim.ev(
      adv('FULFILMENT_SCHEDULED', dxb(6, '12:00'), {
        validUntil: dxb(8, '12:00'),
      }),
      btn('CONFIRM', dxb(6, '13:00'))
    );
    expect(
      sim.sends().filter((s) => s.template === 'pos_delivery_scheduled')
    ).toHaveLength(2);
    expect(after(sim, h)).toEqual([
      'FULFILMENT<-ADVISOR:FULFILMENT_SCHEDULED',
      'WON<-BUTTON:CONFIRM',
    ]);
  });
  it('(b) QUOTE_VALIDITY → PARKED: PROCEED twice stays PARKED; QUOTE_READY re-issues', () => {
    const sim = toDecide(new Sim(), dxb(3, '11:00')).runUntil(dxb(3, '12:00'));
    expect(sim.file).toMatchObject({
      state: 'PARKED',
      prevOpenState: 'P_DECIDE',
      outcome: { reason: 'VALIDITY_LAPSED' },
    });
    const h = sim.file.history.length;
    sim.ev(
      btn('PROCEED', dxb(4, '10:00')),
      btn('PROCEED', dxb(4, '10:01')),
      media(dxb(4, '10:02')),
      inb(dxb(4, '10:03'), 'ok go')
    );
    expect(after(sim, h)).toEqual([]);
    expect(sim.tasks().filter((k) => k === 'REISSUE_OFFER')).toHaveLength(4);
    // silence timer re-armed by the inbound while staying parked
    expect(
      sim.file.timers.find((t) => t.kind === 'PARKED_SILENCE')!.fireAt
    ).toBe(new Date(Date.parse(dxb(34, '10:03'))).toISOString());
    sim.ev(
      adv('QUOTE_READY', dxb(4, '12:00'), { validUntil: dxb(6, '12:00') }),
      btn('PROCEED', dxb(4, '13:00'))
    );
    expect(after(sim, h)).toEqual([
      'P_DECIDE<-ADVISOR:QUOTE_READY',
      'DOCS<-BUTTON:PROCEED',
    ]);
    expect(sim.sends().filter((s) => s.template === 'pos_quote')).toHaveLength(
      2
    );
  });
  it('(c) lapse → 30d silence → RE_ENGAGE → YES_CONTINUE goes back to PARKED with a task, not P_DECIDE', () => {
    const sim = toDecide(new Sim(def, CONSENT), dxb(3, '11:00')).runUntil(
      dxb(34, '12:00')
    );
    expect(sim.file.state).toBe('RE_ENGAGE');
    const h = sim.file.history.length;
    sim.ev(
      btn('YES_CONTINUE', dxb(34, '13:00')),
      btn('PROCEED', dxb(34, '13:01'))
    );
    expect(sim.file).toMatchObject({
      state: 'PARKED',
      prevOpenState: 'P_DECIDE',
      outcome: { kind: 'PARKED', reason: 'VALIDITY_LAPSED' },
    });
    expect(after(sim, h)).toEqual(['PARKED<-BUTTON:YES_CONTINUE']);
    expect(sim.tasks().filter((k) => k === 'REISSUE_OFFER')).toHaveLength(2);
    sim.ev(adv('COMPARISON_READY', dxb(35, '10:00')));
    expect(sim.file.state).toBe('P_DECIDE');
    expect(sim.sends().at(-1)).toMatchObject({
      template: 'pos_rate_comparison',
      category: 'UTILITY',
    });
  });
  it('NOT_NOW park still returns to prevOpenState on inbound', () => {
    const sim = new Sim().ev(
      inb(dxb(1, '10:00')),
      btn('POS', dxb(1, '10:01')),
      btn('NOT_NOW', dxb(1, '10:02')),
      btn('QUOTE', dxb(2, '10:00'))
    );
    expect(sim.file.state).toBe('P_PITCH');
  });
  it('validator reads byReason handlers', () => {
    const d = clone();
    d.states.RE_ENGAGE!.byReason!.VALIDITY_LAPSED!.buttons!.YES_CONTINUE!.to =
      'NOPE';
    expect(validateWorkflow(d)).toContain(
      'RE_ENGAGE.byReason.VALIDITY_LAPSED.buttons.YES_CONTINUE: target "NOPE" is not a state'
    );
  });
});

const media = (at: string) => ({ type: 'MEDIA' as const, count: 1, at });

describe('R5 engine-level caps hold when the workflow is wrong', () => {
  it('(a) a second paid send while PARKED is blocked by the paid-after-parked cap', () => {
    const d = clone();
    const chase = (kind: string, after: string) => ({
      kind,
      anchor: 'enter' as const,
      after,
      then: { send: [{ template: 'docs_reminder' }] },
    });
    d.states.PARKED!.timers!.push(
      chase('CHASE_1', '3d'),
      chase('CHASE_2', '5d')
    );
    const sim = new Sim(d, CONSENT)
      .ev(
        inb(dxb(1, '10:00')),
        btn('POS', dxb(1, '10:01')),
        btn('NOT_NOW', dxb(1, '10:02'))
      )
      .runUntil(dxb(7, '10:00'));
    expect(sim.sends().filter((s) => s.template === 'docs_reminder')).toEqual([
      expect.objectContaining({ billable: true, at: dxb(4, '10:02') }),
    ]);
    expect(sim.warnings.map((w) => w.message)).toContain(
      'docs_reminder not sent: paid-after-parked cap 1'
    );
  });
  it('(b) RE_ENGAGE without consentMarketing guard: send-level opt-in check blocks MARKETING', () => {
    const d = clone();
    d.states.RE_ENGAGE!.guards = ['onceReengage', 'notOptedOut'];
    const sim = new Sim(d, NO_CONSENT)
      .ev(inb(dxb(1, '10:00')))
      .runUntil(dxb(32, '10:00'));
    expect(sim.file.state).toBe('RE_ENGAGE');
    expect(sim.sends().filter((s) => s.category === 'MARKETING')).toEqual([]);
    expect(sim.warnings.map((w) => w.message)).toContain(
      'taamul_reengage_30d not sent: no marketing opt-in'
    );
  });
});

describe('R7 opt-out timers, re-arm, opt-in welcome marker', () => {
  it('(a) opt-out in DOCS keeps the docs reminders; START in WON restores a future THANKYOU only', () => {
    const sim = posToDocs(new Sim())
      .ev(inb(dxb(2, '09:00'), 'STOP'))
      .runUntil(dxb(9, '10:00'));
    expect(
      sim
        .sends()
        .filter((s) => s.template === 'docs_reminder')
        .map((s) => s.at)
    ).toEqual([dxb(4, '16:02'), dxb(8, '16:02')]);

    const won = (s: Sim) =>
      posToDocs(s).ev(
        adv('DOCS_COMPLETE', dxb(2, '10:00')),
        adv('PARTNER_APPROVED', dxb(3, '10:00')),
        adv('FULFILMENT_SCHEDULED', dxb(3, '11:00')),
        btn('CONFIRM', dxb(3, '12:00')),
        inb(dxb(3, '13:00'), 'STOP')
      );
    const early = won(new Sim()).ev(inb(dxb(4, '10:00'), 'START'));
    expect(early.file.timers).toEqual([
      { kind: 'THANKYOU', state: 'WON', fireAt: dxb(5, '12:00') },
    ]);
    const late = won(new Sim()).ev(inb(dxb(6, '10:00'), 'START'));
    expect(late.file.timers).toEqual([]);
  });
  it('(a) opt-out in an open application drops only a timer that would send MARKETING', () => {
    const d = clone();
    d.states.DOCS!.timers!.push({
      kind: 'DOCS_PROMO',
      anchor: 'enter',
      after: '5d',
      then: {
        send: [{ template: 'pos_intro_offer', guards: ['consentMarketing'] }],
      },
    });
    const r = step(
      d,
      posToDocs(new Sim(d)).file,
      inb(dxb(2, '09:00'), 'STOP'),
      dxb(2, '09:00'),
      CONSENT
    );
    expect(r.actions).toContainEqual({
      type: 'CANCEL_TIMERS',
      kinds: ['DOCS_PROMO'],
    });
    expect(r.file.timers.map((t) => t.kind)).toEqual([
      'DOCS_REMINDER_1',
      'DOCS_REMINDER_2',
      'DOCS_SILENCE',
    ]);
  });
  it('(b) an unhandled button and STOP/START keywords re-arm silence timers', () => {
    const menu = new Sim().ev(
      inb(dxb(1, '10:00')),
      btn('NOPE', dxb(20, '10:00'))
    );
    expect(
      menu.file.timers.find((t) => t.kind === 'MENU_SILENCE')!.fireAt
    ).toBe(dxb(50, '10:00'));
    const docs = posToDocs(new Sim()).ev(inb(dxb(3, '10:00'), 'STOP'));
    expect(
      docs.file.timers.find((t) => t.kind === 'DOCS_SILENCE')!.fireAt
    ).toBe(dxb(17, '10:00'));
    docs.ev(inb(dxb(5, '10:00'), 'START'));
    expect(
      docs.file.timers.find((t) => t.kind === 'DOCS_SILENCE')!.fireAt
    ).toBe(dxb(19, '10:00'));
  });
  it('(c) MARK_OPTIN_WELCOME_SENT immediately precedes the opt-in welcome send', () => {
    const r = step(
      def,
      new Sim().file,
      { type: 'START_COLD', at: dxb(1, '10:00') },
      dxb(1, '10:00'),
      CONSENT
    );
    const i = r.actions.findIndex(
      (a) => a.type === 'SEND' && a.template === 'taamul_optin_welcome'
    );
    expect(r.actions[i - 1]).toEqual({
      type: 'MARK_OPTIN_WELCOME_SENT',
      contactId: 'c1',
    });
  });
});
