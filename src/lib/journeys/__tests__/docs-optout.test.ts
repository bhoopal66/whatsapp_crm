import { describe, expect, it } from 'vitest';
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

describe('documents stage', () => {
  it('reminders on day 3 and day 7, never a third; NEED_MORE_TIME parks', () => {
    const sim = posToDocs(new Sim()).runUntil(dxb(11, '10:00'));
    const rem = sim.sends().filter((s) => s.template === 'docs_reminder');
    expect(rem.map((s) => s.at)).toEqual([dxb(4, '16:02'), dxb(8, '16:02')]);
    expect(sim.file.counters.remindersThisStage).toBe(2);
    sim.ev({ type: 'TIMER', kind: 'DOCS_REMINDER_2', at: dxb(11, '11:00') });
    expect(
      sim.sends().filter((s) => s.template === 'docs_reminder')
    ).toHaveLength(2);
    sim.ev(btn('NEED_MORE_TIME', dxb(11, '12:00')));
    expect(sim.file).toMatchObject({
      state: 'PARKED',
      prevOpenState: 'DOCS',
      outcome: { kind: 'PARKED', reason: 'NEED_TIME' },
    });
  });
  it('cap blocks a third reminder even if the workflow schedules one', () => {
    const d = clone();
    d.states.DOCS!.timers!.push({
      kind: 'DOCS_REMINDER_3',
      anchor: 'enter',
      after: '10d',
      then: {
        send: [{ template: 'docs_reminder', counter: 'remindersThisStage' }],
      },
    });
    const sim = posToDocs(new Sim(d)).runUntil(dxb(12, '10:00'));
    expect(
      sim.sends().filter((s) => s.template === 'docs_reminder')
    ).toHaveLength(2);
    expect(sim.warnings.map((w) => w.code)).toContain('CAP_REACHED');
  });
  it('quiet hours: day-3 reminder due 23:00 Dubai carries notBefore next day 09:00 Dubai', () => {
    const sim = posToDocs(new Sim(), 1, [
      '22:50',
      '22:51',
      '22:52',
      '22:55',
      '23:00',
    ]).runUntil(dxb(5, '00:00'));
    const r = sim.sends().find((s) => s.template === 'docs_reminder')!;
    expect(r).toMatchObject({
      at: dxb(4, '23:00'),
      billable: true,
      notBefore: dxb(5, '09:00'),
    });
    expect(
      sim.sends().find((s) => s.template === 'pos_docs_request')!.notBefore
    ).toBeUndefined();
  });
});

describe('opt-out', () => {
  const keywordCases: [string, string, (s: Sim) => Sim][] = [
    ['STOP', 'S_MENU', (s) => s.ev(inb(dxb(1, '10:00')))],
    [
      '  unsubscribe. ',
      'P_PITCH',
      (s) => s.ev(inb(dxb(1, '10:00')), btn('POS', dxb(1, '10:01'))),
    ],
    [
      'إلغاء',
      'PARKED',
      (s) =>
        s.ev(
          inb(dxb(1, '10:00')),
          btn('POS', dxb(1, '10:01')),
          btn('NOT_NOW', dxb(1, '10:02'))
        ),
    ],
    [
      'الغاء',
      'L_PITCH',
      (s) => s.ev(inb(dxb(1, '10:00')), btn('LOAN', dxb(1, '10:01'))),
    ],
    [
      'إِيقَاف',
      'B_PITCH',
      (s) => s.ev(inb(dxb(1, '10:00')), btn('ACCOUNT', dxb(1, '10:01'))),
    ],
    ['ايقاف', 'NEW', (s) => s],
  ];
  it.each(keywordCases)(
    '%s in %s → CLOSED_OPTED_OUT with a free confirm',
    (kw, from, setup) => {
      const sim = setup(new Sim());
      expect(sim.file.state).toBe(from);
      sim.ev(inb(dxb(1, '11:00'), kw));
      expect(sim.file).toMatchObject({
        state: 'CLOSED_OPTED_OUT',
        optedOut: true,
        timers: [],
        outcome: { kind: 'NOT_WON', reason: 'OPT_OUT' },
      });
      expect(sim.sends().at(-1)).toMatchObject({
        template: 'taamul_optout_confirm',
        category: 'UTILITY',
        billable: false,
      });
      expect(sim.log.map((x) => x.action)).toContainEqual({
        type: 'SET_OPT_OUT',
        optedOut: true,
      });
    }
  );
  it('a sentence containing a keyword is not an opt-out', () => {
    const sim = new Sim().ev(
      inb(dxb(1, '10:00')),
      inb(dxb(1, '10:01'), 'please stop the old terminal')
    );
    expect(sim.file).toMatchObject({ state: 'S_MENU', optedOut: false });
  });
  it('open application keeps its state; UTILITY still flows; MARKETING blocked; START re-subscribes', () => {
    const sim = posToDocs(new Sim(def, CONSENT)).ev(
      inb(dxb(2, '09:00'), 'إيقاف')
    );
    // R7a: an open application keeps its non-marketing timers through an opt-out (was `timers: []`).
    expect(sim.file).toMatchObject({ state: 'DOCS', optedOut: true });
    expect(sim.file.timers.map((t) => t.kind)).toEqual([
      'DOCS_REMINDER_1',
      'DOCS_REMINDER_2',
      'DOCS_SILENCE',
    ]);
    sim
      .ev(
        adv('DOCS_COMPLETE', dxb(2, '10:00')),
        adv('PARTNER_MORE_INFO', dxb(3, '10:00'))
      )
      .runUntil(dxb(30, '10:00'));
    expect(
      sim
        .sends()
        .map((s) => s.template)
        .slice(4)
    ).toEqual([
      'taamul_optout_confirm',
      'pos_application_status',
      'pos_docs_request',
      'docs_reminder',
      'docs_reminder',
    ]);
    expect(sim.file.state).toBe('CLOSED_NO_RESPONSE');
    expect(sim.sends().some((s) => s.category === 'MARKETING')).toBe(false);

    const back = posToDocs(new Sim(def, CONSENT)).ev(
      inb(dxb(2, '09:00'), 'STOP'),
      inb(dxb(2, '09:05'), 'Start')
    );
    expect(back.file).toMatchObject({ state: 'DOCS', optedOut: false });
    // R7b: START now also re-arms silence timers, so SET_OPT_OUT is no longer the last action (was `.at(-1)`).
    expect(back.log.map((x) => x.action)).toContainEqual({
      type: 'SET_OPT_OUT',
      optedOut: false,
    });
  });
  it('engine blocks MARKETING to an opted-out file even if the workflow forgets the guard', () => {
    const d = clone();
    d.states.RE_ENGAGE!.guards = ['onceReengage', 'consentMarketing'];
    const sim = posToDocs(new Sim(d, CONSENT))
      .ev(inb(dxb(2, '09:00'), 'stop'))
      .ev(
        adv('DOCS_COMPLETE', dxb(2, '10:00')),
        adv('PARTNER_MORE_INFO', dxb(3, '10:00'))
      )
      .runUntil(dxb(18, '10:00'));
    expect(sim.file.state).toBe('RE_ENGAGE');
    expect(sim.sends().some((s) => s.category === 'MARKETING')).toBe(false);
    expect(sim.warnings.map((w) => w.code)).toContain('OPTED_OUT');
  });
  it('no-consent inbound lead also gets no MARKETING after opt-out + START', () => {
    const sim = new Sim(def, NO_CONSENT).ev(
      inb(dxb(1, '10:00')),
      inb(dxb(1, '10:01'), 'STOP'),
      inb(dxb(1, '10:02'), 'START')
    );
    expect(sim.file).toMatchObject({
      state: 'CLOSED_OPTED_OUT',
      optedOut: false,
    });
    sim.runUntil(dxb(41, '10:00'));
    // open application: opt-out keeps the file open; after START the silence path must still not market
    const open = posToDocs(new Sim(def, NO_CONSENT)).ev(
      inb(dxb(2, '09:00'), 'STOP'),
      inb(dxb(2, '09:05'), 'START')
    );
    expect(open.file).toMatchObject({ state: 'DOCS', optedOut: false });
    open.runUntil(dxb(41, '10:00'));
    expect(open.file.state).toBe('CLOSED_NO_RESPONSE');
    for (const s of [sim, open])
      expect(s.sends().filter((x) => x.category === 'MARKETING')).toEqual([]);
  });
});

describe('review fixes', () => {
  it('ACCOUNT: submission sends acct_application_status; acct_bank_matched only at fulfilment', () => {
    const sim = new Sim(def, CONSENT).ev(
      inb(dxb(1, '10:00')),
      btn('ACCOUNT', dxb(1, '10:01')),
      btn('CHECK_ELIGIBILITY', dxb(1, '10:02')),
      adv('FIT', dxb(1, '11:00')),
      adv('DOCS_COMPLETE', dxb(1, '12:00')),
      adv('SUBMITTED', dxb(1, '12:05'))
    );
    const t = () => sim.sends().map((s) => s.template);
    expect(t()).toContain('acct_application_status');
    expect(t()).not.toContain('acct_bank_matched');
    sim.ev(
      adv('PARTNER_APPROVED', dxb(3, '10:00')),
      adv('FULFILMENT_SCHEDULED', dxb(3, '11:00'))
    );
    expect(t().filter((x) => x === 'acct_bank_matched')).toHaveLength(1);
  });
  it('opt-out blocks MARKETING only: a SESSION message to an opted-out open application still goes', () => {
    const d = clone();
    d.states.DOCS!.onEnter!.send!.push({
      template: 'pos_pitch_in_window',
    } as never);
    // opt out while in DOCS, then re-enter DOCS via SUBMITTED → PARTNER_MORE_INFO
    const s2 = posToDocs(new Sim(d, CONSENT)).ev(
      inb(dxb(2, '09:00'), 'STOP'),
      adv('DOCS_COMPLETE', dxb(2, '09:05')),
      adv('PARTNER_MORE_INFO', dxb(2, '09:10'))
    );
    const after = s2
      .sends()
      .slice(
        s2.sends().findIndex((x) => x.template === 'taamul_optout_confirm')
      );
    expect(after.map((x) => x.template)).toContain('pos_pitch_in_window');
    expect(s2.warnings.filter((w) => w.code === 'OPTED_OUT')).toHaveLength(0);
  });
});
