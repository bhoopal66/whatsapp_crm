import { describe, expect, it } from 'vitest';
import { validateWorkflow } from '../index';
import { clone, def } from './helpers';

describe('validateWorkflow', () => {
  it('passes on the shipped JSON', () => {
    expect(validateWorkflow(def)).toEqual([]);
  });
  it('dangling transition target', () => {
    const d = clone();
    d.states.S_MENU!.buttons!.POS!.to = 'P_PITCHX';
    expect(validateWorkflow(d)).toContain(
      'S_MENU.buttons.POS: target "P_PITCHX" is not a state'
    );
  });
  it('unreachable state', () => {
    const d = clone();
    d.states.ORPHAN = { buttons: { X: { to: 'S_MENU' } } };
    expect(validateWorkflow(d)).toEqual(['ORPHAN: unreachable from any entry']);
  });
  it('terminal NOT_WON without reason', () => {
    const d = clone();
    delete d.states.CLOSED_DECLINED!.outcome!.reason;
    expect(validateWorkflow(d)).toEqual([
      'CLOSED_DECLINED: NOT_WON terminal state has no reason code',
    ]);
  });
  it('unregistered template (incl. {product} expansion)', () => {
    const d = clone();
    delete d.templates.loan_docs_request;
    expect(validateWorkflow(d)).toEqual([
      'DOCS.onEnter: template "loan_docs_request" is not in the template registry',
    ]);
  });
  it('MARKETING without consent guard on an inbound-reachable state', () => {
    const d = clone();
    d.states.RE_ENGAGE!.guards = ['onceReengage', 'notOptedOut'];
    expect(validateWorkflow(d)).toEqual([
      'RE_ENGAGE.onEnter: MARKETING template "taamul_reengage_30d" sent without consentMarketing guard',
    ]);
    const d2 = clone();
    delete d2.states.P_PITCH!.onEnter!.send![1]!.guards;
    expect(validateWorkflow(d2)).toEqual([
      'P_PITCH.onEnter: MARKETING template "pos_intro_offer" sent without consentMarketing guard',
      'P_PITCH.onEnter: MARKETING template "pos_switch_offer" sent without consentMarketing guard',
    ]);
  });
  it('non-terminal state with no way out; event-reason close without reasonRequired', () => {
    const d = clone();
    d.states.P_QUOTE_WAIT!.advisor = {};
    d.globalAdvisor.CLOSE!.guards = [];
    expect(validateWorkflow(d)).toEqual([
      'P_QUOTE_WAIT: non-terminal state has no way out (button, advisor event or timer)',
      'globalAdvisor.CLOSE: closes into "CLOSED_ADVISOR" (reason from event) without reasonRequired guard',
    ]);
  });
});

describe('session message button limits', () => {
  it('shipped workflow passes; a 5-option SESSION message needs interactive: list', () => {
    expect(validateWorkflow(clone())).toEqual([]);
    const d = clone();
    delete (d.templates.pos_pitch_in_window as { interactive?: string })
      .interactive;
    expect(validateWorkflow(d).join('\n')).toMatch(
      /pos_pitch_in_window: SESSION buttons message has 5 options; WhatsApp allows 3/
    );
    const e = clone();
    e.templates.welcome_menu!.buttons = Array.from(
      { length: 11 },
      (_, i) => `B${i}`
    );
    e.templates.welcome_menu!.interactive = 'list';
    expect(validateWorkflow(e).join('\n')).toMatch(
      /welcome_menu: SESSION list message has 11 options; WhatsApp allows 10/
    );
  });
});
