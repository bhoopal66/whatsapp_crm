import { describe, expect, it } from 'vitest';
import {
  newFile,
  step,
  validateWorkflow,
  type Action,
  type JourneyFile,
  type StepContext,
} from '../index';
import { btn, clone, CONSENT, def, dxb, inb, Sim } from './helpers';

type Of<T extends Action['type']> = Extract<Action, { type: T }>;
const only = <T extends Action['type']>(actions: Action[], type: T) =>
  actions.filter((a): a is Of<T> => a.type === type);
const tap = (at: string) => btn('CALL_ME_BACK', at);

/** Inbound POS lead in P_PITCH (entered day 1 10:15 Dubai). */
const pitch = (ctx: StepContext = CONSENT) =>
  new Sim(def, ctx).ev(inb(dxb(1, '10:14')), btn('POS', dxb(1, '10:15')));
const stepOn = (file: JourneyFile, at: string, ctx: StepContext = CONSENT) =>
  step(def, file, tap(at), at, ctx);

describe('CALL_ME_BACK (D-016-6: callbacks via Yeastar / module 015)', () => {
  it('in P_PITCH at 11:00 Dubai: state unchanged, free ack, CALLBACK task due +15m, REQUEST_CALLBACK without notBefore', () => {
    const sim = pitch();
    const at = dxb(1, '11:00');
    const r = stepOn(sim.file, at);
    expect(r.error).toBeUndefined();
    expect(r.file.state).toBe('P_PITCH');
    expect(r.file.history).toEqual(sim.file.history);
    expect(only(r.actions, 'SEND')).toEqual([
      {
        type: 'SEND',
        template: 'callback_ack',
        category: 'SESSION',
        billable: false,
        variant: 'IN_HOURS',
      },
    ]);
    const tasks = only(r.actions, 'ADVISOR_TASK');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      kind: 'CALLBACK',
      dueAt: dxb(1, '11:15'),
    });
    expect(only(r.actions, 'REQUEST_CALLBACK')).toEqual([
      { type: 'REQUEST_CALLBACK', contactId: 'c1', fileId: 'f1' },
    ]);
    expect(only(r.actions, 'LOG_COST')).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('at 22:30 Dubai: REQUEST_CALLBACK.notBefore and task due = next 09:00 Dubai; out-of-hours ack', () => {
    const r = stepOn(pitch().file, dxb(1, '22:30'));
    expect(r.file.state).toBe('P_PITCH');
    expect(only(r.actions, 'REQUEST_CALLBACK')).toEqual([
      {
        type: 'REQUEST_CALLBACK',
        contactId: 'c1',
        fileId: 'f1',
        notBefore: dxb(2, '09:00'),
      },
    ]);
    expect(only(r.actions, 'ADVISOR_TASK')[0]).toMatchObject({
      kind: 'CALLBACK',
      dueAt: dxb(2, '09:00'),
    });
    const [ack] = only(r.actions, 'SEND');
    expect(ack).toMatchObject({
      template: 'callback_ack',
      billable: false,
      variant: 'OUT_OF_HOURS',
    });
    expect(ack!.notBefore).toBeUndefined(); // a reply to the tap goes at once
  });

  it('doNotContact: CALLBACK_BLOCKED_DNC task only — no REQUEST_CALLBACK, no ack (marketing opt-out alone does not block)', () => {
    const dnc: StepContext = {
      ...CONSENT,
      consent: { ...CONSENT.consent, doNotContact: true },
    };
    const r = stepOn(pitch().file, dxb(1, '11:00'), dnc);
    expect(r.file.state).toBe('P_PITCH');
    expect(only(r.actions, 'ADVISOR_TASK').map((t) => t.kind)).toEqual([
      'CALLBACK_BLOCKED_DNC',
    ]);
    expect(only(r.actions, 'REQUEST_CALLBACK')).toEqual([]);
    expect(only(r.actions, 'SEND')).toEqual([]);

    const optedOut: StepContext = {
      ...CONSENT,
      consent: { marketingOptIn: false, optedOut: true },
    };
    const r2 = stepOn(pitch().file, dxb(1, '11:00'), optedOut);
    expect(only(r2.actions, 'REQUEST_CALLBACK')).toHaveLength(1);
    expect(only(r2.actions, 'SEND').map((s) => s.template)).toEqual([
      'callback_ack',
    ]);
  });

  it('second tap within 2h: ack only + CALLBACK_THROTTLED; after 2h a new request is allowed', () => {
    const first = stepOn(pitch().file, dxb(1, '11:00'));
    const again = stepOn(first.file, dxb(1, '12:59'));
    expect(only(again.actions, 'REQUEST_CALLBACK')).toEqual([]);
    expect(only(again.actions, 'ADVISOR_TASK')).toEqual([]);
    expect(only(again.actions, 'SEND').map((s) => s.template)).toEqual([
      'callback_ack',
    ]);
    expect(again.warnings.map((w) => w.code)).toEqual(['CALLBACK_THROTTLED']);
    const later = stepOn(again.file, dxb(1, '13:00'));
    expect(only(later.actions, 'REQUEST_CALLBACK')).toHaveLength(1);
    expect(later.warnings).toEqual([]);
  });

  it('in WON: CALLBACK task + ack, no REQUEST_CALLBACK, state stays WON', () => {
    const won: JourneyFile = {
      ...newFile({
        id: 'f1',
        contactId: 'c1',
        workspaceId: 'w1',
        product: 'POS',
      }),
      entry: 'INBOUND',
      state: 'WON',
      outcome: { kind: 'WON', reason: 'CONVERTED' },
      window: { lastInboundAt: dxb(1, '10:00'), freeEntryUntil: null },
    };
    const r = stepOn(won, dxb(1, '11:00'));
    expect(r.file.state).toBe('WON');
    expect(r.file.outcome).toEqual({ kind: 'WON', reason: 'CONVERTED' });
    expect(only(r.actions, 'ADVISOR_TASK').map((t) => t.kind)).toEqual([
      'CALLBACK',
    ]);
    expect(only(r.actions, 'REQUEST_CALLBACK')).toEqual([]);
    expect(only(r.actions, 'SEND').map((s) => s.template)).toEqual([
      'callback_ack',
    ]);
    expect(only(r.actions, 'CLOSE')).toEqual([]);
  });

  it('refreshes the window and re-arms the P_PITCH 30d silence timer', () => {
    const sim = pitch();
    expect(sim.file.timers).toEqual([
      { kind: 'PITCH_SILENCE', fireAt: dxb(31, '10:15'), state: 'P_PITCH' },
    ]);
    const at = dxb(10, '11:00'); // window long closed
    const r = stepOn(sim.file, at);
    expect(r.file.window.lastInboundAt).toBe(at);
    expect(r.file.timers).toEqual([
      { kind: 'PITCH_SILENCE', fireAt: dxb(40, '11:00'), state: 'P_PITCH' },
    ]);
    expect(only(r.actions, 'SET_TIMER')).toEqual([
      { type: 'SET_TIMER', kind: 'PITCH_SILENCE', fireAt: dxb(40, '11:00') },
    ]);
    expect(only(r.actions, 'SEND')[0]).toMatchObject({
      template: 'callback_ack',
      billable: false,
    });
  });
});

describe('template registry: CALL_ME_BACK and phone buttons', () => {
  const CMB = [
    'pos_pitch_in_window',
    'pos_intro_offer',
    'pos_switch_offer',
    'acct_pitch_in_window',
    'acct_intro_offer',
    'loan_pitch_in_window',
    'loan_intro_offer',
    'pos_quote',
    'pos_rate_comparison',
    'acct_eligibility_prescreen',
    'loan_eligibility_prescreen',
    'pos_docs_request',
    'acct_docs_request',
    'loan_docs_request',
    'docs_reminder',
    'declined_rematch',
    'loan_offer_received',
  ];
  const PHONE = [
    'pos_docs_request',
    'acct_docs_request',
    'loan_docs_request',
    'pos_application_status',
    'acct_application_status',
    'loan_application_status',
    'pos_delivery_scheduled',
    'acct_bank_matched',
    'loan_offer_received',
  ];

  it('shipped JSON: valid; CALL_ME_BACK and {TAAMUL_DID} phone button on the listed templates; ≤ 10 buttons each; callback_ack SESSION', () => {
    expect(validateWorkflow(def)).toEqual([]);
    for (const n of CMB)
      expect(def.templates[n]!.buttons, n).toContain('CALL_ME_BACK');
    for (const n of PHONE)
      expect(def.templates[n]!.phoneButton, n).toEqual({
        label: 'Call Taamul',
        number: '{TAAMUL_DID}',
      });
    for (const [n, t] of Object.entries(def.templates))
      expect(t.buttons.length + (t.phoneButton ? 1 : 0), n).toBeLessThanOrEqual(
        10
      );
    expect(def.templates.callback_ack?.category).toBe('SESSION');
  });

  it('two phone buttons → error; bad number → error; E.164 accepted', () => {
    const d = clone();
    (
      d.templates.pos_docs_request as unknown as { phoneButton: unknown }
    ).phoneButton = [
      { label: 'A', number: '{TAAMUL_DID}' },
      { label: 'B', number: '+97140000000' },
    ];
    expect(validateWorkflow(d)).toEqual([
      'templates.pos_docs_request: at most one phone button per template (has 2)',
    ]);
    const d2 = clone();
    d2.templates.pos_docs_request!.phoneButton = {
      label: 'Call',
      number: '04 123 4567',
    };
    expect(validateWorkflow(d2)).toEqual([
      'templates.pos_docs_request: phone button number "04 123 4567" is not a {PLACEHOLDER} or E.164',
    ]);
    const d3 = clone();
    d3.templates.pos_docs_request!.phoneButton = {
      label: 'Call',
      number: '+97142345678',
    };
    expect(validateWorkflow(d3)).toEqual([]);
  });

  it('more than 10 buttons on a template → error', () => {
    const d = clone();
    d.templates.pos_quote!.buttons = Array.from(
      { length: 10 },
      (_, i) => `B${i}`
    );
    d.templates.pos_quote!.phoneButton = {
      label: 'Call',
      number: '{TAAMUL_DID}',
    };
    expect(validateWorkflow(d)).toEqual([
      "templates.pos_quote: 11 buttons exceed WhatsApp's 10 per template",
    ]);
  });
});
