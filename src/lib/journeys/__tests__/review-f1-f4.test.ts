import { describe, expect, it } from 'vitest';
import {
  createRunner,
  newFile,
  step,
  type ConsentPort,
  type JourneyEvent,
  type OutboxItem,
  type RunnerEvent,
} from '../index';
import {
  CONSENT,
  MemorySink,
  MemoryStore,
  Sim,
  adv,
  btn,
  def,
  dxb,
  inb,
  media,
  posToDocs,
} from './helpers';

/** Inbound POS lead on day 1 up to the quote, issued with the given validUntil. */
const toQuote = (sim: Sim, validUntil?: string) =>
  sim.ev(
    inb(dxb(1, '10:14')),
    btn('POS', dxb(1, '10:15')),
    btn('QUOTE', dxb(1, '10:16')),
    adv('QUOTE_READY', dxb(1, '15:40'), validUntil ? { validUntil } : {})
  );
const states = (sim: Sim) => sim.file.history.map((h) => h.to);

describe('F1 quote/offer validity is checked on every entry into P_DECIDE / FULFILMENT', () => {
  it('F1a: PROCEED after the quote lapsed while parked → PARKED VALIDITY_LAPSED + REISSUE_OFFER, never DOCS; re-issue → DOCS', () => {
    const sim = toQuote(new Sim(), dxb(3, '12:00')).ev(
      btn('NOT_NOW', dxb(1, '16:00'))
    );
    expect(sim.file).toMatchObject({
      state: 'PARKED',
      outcome: { kind: 'PARKED', reason: 'NOT_NOW' },
      prevOpenState: 'P_DECIDE',
    });

    sim.ev(btn('PROCEED', dxb(10, '10:00')));
    expect(sim.file).toMatchObject({
      state: 'PARKED',
      outcome: { kind: 'PARKED', reason: 'VALIDITY_LAPSED' },
    });
    expect(sim.tasks().filter((k) => k === 'REISSUE_OFFER')).toHaveLength(1);

    sim.ev(btn('PROCEED', dxb(10, '10:05')));
    expect(sim.file).toMatchObject({
      state: 'PARKED',
      outcome: { kind: 'PARKED', reason: 'VALIDITY_LAPSED' },
    });
    expect(sim.tasks().filter((k) => k === 'REISSUE_OFFER')).toHaveLength(2);
    expect(states(sim)).not.toContain('DOCS');

    sim.ev(
      adv('QUOTE_READY', dxb(10, '11:00'), { validUntil: dxb(13, '12:00') })
    );
    expect(sim.file).toMatchObject({
      state: 'P_DECIDE',
      validUntil: { quote: dxb(13, '12:00') },
    });
    expect(
      sim.file.timers.find((t) => t.kind === 'QUOTE_VALIDITY')?.fireAt
    ).toBe(dxb(13, '12:00'));
    sim.ev(btn('PROCEED', dxb(10, '11:05')));
    expect(sim.file.state).toBe('DOCS');
    expect(sim.sends().filter((s) => s.template === 'pos_quote')).toHaveLength(
      2
    );
  });

  it('F1b: RE_ENGAGE YES_CONTINUE back into a P_DECIDE whose quote has lapsed → PARKED VALIDITY_LAPSED', () => {
    // Quote valid past the 30d silence, so DECIDE_SILENCE (not QUOTE_VALIDITY) moves the file to RE_ENGAGE.
    const sim = toQuote(new Sim(), dxb(33, '12:00')).runUntil(dxb(32, '12:00'));
    expect(sim.file).toMatchObject({
      state: 'RE_ENGAGE',
      prevOpenState: 'P_DECIDE',
    });
    expect(sim.sends().map((s) => s.template)).toContain('taamul_reengage_30d');

    sim.ev(btn('YES_CONTINUE', dxb(34, '10:00')));
    expect(sim.file).toMatchObject({
      state: 'PARKED',
      outcome: { kind: 'PARKED', reason: 'VALIDITY_LAPSED' },
    });
    expect(sim.tasks()).toContain('REISSUE_OFFER');
    expect(states(sim).slice(-2)).toEqual(['RE_ENGAGE', 'PARKED']);
  });

  it('F1c: quote without validUntil and a silent customer → DECIDE_SILENCE → RE_ENGAGE → closed, never stuck', () => {
    const sim = toQuote(new Sim());
    expect(sim.file.state).toBe('P_DECIDE');
    expect(sim.file.timers.map((t) => t.kind)).toEqual(['DECIDE_SILENCE']);
    sim.runUntil(dxb(90, '12:00'));
    expect(states(sim).slice(-3)).toEqual([
      'P_DECIDE',
      'RE_ENGAGE',
      'CLOSED_NO_RESPONSE',
    ]);
    expect(sim.file).toMatchObject({
      state: 'CLOSED_NO_RESPONSE',
      outcome: { kind: 'NOT_WON', reason: 'NO_RESPONSE' },
      timers: [],
    });
  });

  it('F1d: FULFILMENT offer slot — FULFILMENT_SILENCE → RE_ENGAGE; YES_CONTINUE after the offer expired → PARKED VALIDITY_LAPSED', () => {
    const sim = posToDocs(new Sim()).ev(
      media(dxb(2, '09:20')),
      adv('DOCS_COMPLETE', dxb(3, '10:00')),
      adv('PARTNER_APPROVED', dxb(5, '11:00')),
      adv('FULFILMENT_SCHEDULED', dxb(6, '10:00'), {
        validUntil: dxb(36, '12:00'),
      })
    );
    expect(sim.file).toMatchObject({
      state: 'FULFILMENT',
      validUntil: { offer: dxb(36, '12:00') },
    });
    sim.runUntil(dxb(35, '23:00'));
    expect(sim.file).toMatchObject({
      state: 'RE_ENGAGE',
      prevOpenState: 'FULFILMENT',
    });
    sim.ev(btn('YES_CONTINUE', dxb(37, '10:00')));
    expect(sim.file).toMatchObject({
      state: 'PARKED',
      outcome: { kind: 'PARKED', reason: 'VALIDITY_LAPSED' },
    });
    expect(sim.tasks()).toContain('REISSUE_OFFER');
    expect(states(sim)).not.toContain('WON');
  });
});

/** Consent register fed by the sink, as a host would: SET_OPT_OUT / MARK_OPTIN_WELCOME_SENT land when delivered. */
class Register implements ConsentPort {
  optedOut = new Set<string>();
  received = new Set<string>();
  claims = new Map<string, string>();
  optIn = true;
  async hasMarketingOptIn() {
    return this.optIn;
  }
  async isOptedOut(c: string) {
    return this.optedOut.has(c);
  }
  async hasReceivedOptinWelcome(c: string) {
    return this.received.has(c);
  }
  async claimOptinWelcome(c: string, claimId: string) {
    const cur = this.claims.get(c);
    if (cur === undefined) {
      this.claims.set(c, claimId);
      return true;
    }
    return cur === claimId;
  }
}
class RegisterSink extends MemorySink {
  constructor(
    private reg: Register,
    private contactOf: (fileId: string) => string
  ) {
    super();
  }
  override async deliver(item: OutboxItem): Promise<void> {
    await super.deliver(item);
    const a = item.action,
      c = this.contactOf(item.fileId);
    if (a.type === 'SET_OPT_OUT') {
      if (a.optedOut) this.reg.optedOut.add(c);
      else this.reg.optedOut.delete(c);
    }
    if (a.type === 'MARK_OPTIN_WELCOME_SENT') this.reg.received.add(c);
  }
}
function harness(...fileIds: string[]) {
  const store = new MemoryStore(
    ...fileIds.map((id) => newFile({ id, contactId: 'c1', workspaceId: 'w1' }))
  );
  const consent = new Register(),
    sink = new RegisterSink(consent, (id) => store.files.get(id)!.contactId);
  return {
    store,
    consent,
    sink,
    runner: createRunner({ def, store, sink, consent }),
  };
}
const ev = (fileId: string, id: string, e: JourneyEvent): RunnerEvent => ({
  ...e,
  id,
  fileId,
});
const sendItems = (store: MemoryStore, template: string) =>
  store.outbox.filter(
    (i) => i.action.type === 'SEND' && i.action.template === template
  );
const isSend = (i: OutboxItem, template: string) =>
  i.action.type === 'SEND' && i.action.template === template;

describe('F2 delivery-time consent re-check', () => {
  it("F2a: opt-out committed on file A but not yet delivered → file B's MARKETING re-engage is dropped, never delivered", async () => {
    const h = harness('A', 'B');
    await h.runner.handle(
      ev('A', 'a.hi', { type: 'INBOUND_TEXT', text: 'Hi', at: dxb(1, '10:00') })
    );
    await h.runner.handle(
      ev('B', 'b.hi', { type: 'INBOUND_TEXT', text: 'Hi', at: dxb(1, '10:00') })
    );
    await h.runner.handle(
      ev('B', 'b.pos', { type: 'BUTTON', payload: 'POS', at: dxb(1, '10:01') })
    );
    h.sink.fail = (i) => i.fileId === 'A';
    const stop = await h.runner.handle(
      ev('A', 'a.stop', {
        type: 'INBOUND_TEXT',
        text: 'STOP',
        at: dxb(2, '10:00'),
      })
    );
    expect(stop).toMatchObject({ status: 'ok', drain: { delivered: 0 } });
    expect(h.consent.optedOut.has('c1')).toBe(false); // register not updated: SET_OPT_OUT still pending

    const fireAt = h.store.files
      .get('B')!
      .timers.find((t) => t.kind === 'PITCH_SILENCE')!.fireAt;
    const r = await h.runner.handle(
      ev('B', 'b.t', { type: 'TIMER', kind: 'PITCH_SILENCE', at: fireAt })
    );
    expect(r).toMatchObject({
      status: 'ok',
      result: { file: { state: 'RE_ENGAGE' } },
    });
    const [item] = sendItems(h.store, 'taamul_reengage_30d');
    expect(item).toMatchObject({ status: 'dropped', dropReason: 'OPTED_OUT' });
    expect(h.sink.delivered.some((i) => isSend(i, 'taamul_reengage_30d'))).toBe(
      false
    );
    expect(
      h.sink.delivered.some(
        (i) =>
          i.action.type === 'LOG_COST' &&
          i.action.template === 'taamul_reengage_30d'
      )
    ).toBe(false);
    expect(await h.runner.drain('B', fireAt)).toMatchObject({ pending: 0 });
    expect(h.sink.sends()).not.toContain('taamul_reengage_30d');
  });

  it('F2b: START_COLD on two files of one contact → exactly one opt-in welcome; a retried delivery of the winner is not dropped', async () => {
    const h = harness('A', 'B');
    let failures = 1;
    h.sink.fail = (i) => isSend(i, 'taamul_optin_welcome') && failures-- > 0;
    const rs = await Promise.all([
      h.runner.handle(
        ev('A', 'a.cold', { type: 'START_COLD', at: dxb(1, '10:00') })
      ),
      h.runner.handle(
        ev('B', 'b.cold', { type: 'START_COLD', at: dxb(1, '10:00') })
      ),
    ]);
    expect(rs.map((r) => r.status)).toEqual(['ok', 'ok']);
    const welcomes = sendItems(h.store, 'taamul_optin_welcome');
    expect(welcomes).toHaveLength(2); // both steps passed the step-time cap (race)
    const dropped = welcomes.filter((i) => i.status === 'dropped');
    expect(dropped).toEqual([
      expect.objectContaining({ dropReason: 'CAP_REACHED' }),
    ]);
    const winner = welcomes.find((i) => i.status === 'pending')!;
    expect(winner).toBeDefined(); // its first delivery failed after the claim
    expect(h.sink.sends()).not.toContain('taamul_optin_welcome');

    await h.runner.drain('A', dxb(1, '10:05'));
    await h.runner.drain('B', dxb(1, '10:05'));
    expect(winner.status).toBe('delivered');
    expect(
      h.sink.sends().filter((t) => t === 'taamul_optin_welcome')
    ).toHaveLength(1);
    expect(
      h.sink.delivered.filter(
        (i) =>
          i.action.type === 'LOG_COST' &&
          i.action.template === 'taamul_optin_welcome'
      )
    ).toHaveLength(1);
  });

  it('F2c: welcome deferred by quiet hours, then STOP before its notBefore → opt-out confirmed at once, welcome never delivered', async () => {
    const h = harness('A');
    const cold = await h.runner.handle(
      ev('A', 'a.cold', { type: 'START_COLD', at: dxb(1, '23:00') })
    );
    expect(cold).toMatchObject({
      status: 'ok',
      drain: { deferredUntil: dxb(2, '09:00') },
    });
    expect(sendItems(h.store, 'taamul_optin_welcome')[0]).toMatchObject({
      status: 'pending',
      action: { notBefore: dxb(2, '09:00') },
    });
    expect(await h.runner.drain('A', dxb(2, '08:59'))).toMatchObject({
      delivered: 0,
      deferredUntil: dxb(2, '09:00'),
    });

    const stop = await h.runner.handle(
      ev('A', 'a.stop', {
        type: 'INBOUND_TEXT',
        text: 'STOP',
        at: dxb(1, '23:30'),
      })
    );
    expect(stop).toMatchObject({
      status: 'ok',
      drain: { deferredUntil: dxb(2, '09:00') },
    });
    // the held welcome must not delay the opt-out: confirmation and register update go out at 23:30
    expect(h.sink.sends()).toEqual(['taamul_optout_confirm']);
    expect(h.consent.optedOut.has('c1')).toBe(true);

    const d = await h.runner.drain('A', dxb(2, '09:00'));
    expect(d).toMatchObject({ pending: 0 });
    expect(d.dropped).toBeGreaterThan(0);
    expect(sendItems(h.store, 'taamul_optin_welcome')[0]).toMatchObject({
      status: 'dropped',
      dropReason: 'OPTED_OUT',
    });
    expect(h.sink.sends()).toEqual(['taamul_optout_confirm']);
    expect(h.consent.optedOut.has('c1')).toBe(true);
  });

  it('F2d: marketing opt-in withdrawn between commit and delivery → the MARKETING send is dropped NO_CONSENT', async () => {
    const h = harness('B');
    await h.runner.handle(
      ev('B', 'b.hi', { type: 'INBOUND_TEXT', text: 'Hi', at: dxb(1, '10:00') })
    );
    await h.runner.handle(
      ev('B', 'b.pos', { type: 'BUTTON', payload: 'POS', at: dxb(1, '10:01') })
    );
    const fireAt = h.store.files
      .get('B')!
      .timers.find((t) => t.kind === 'PITCH_SILENCE')!.fireAt;
    h.sink.fail = () => true;
    await h.runner.handle(
      ev('B', 'b.t', { type: 'TIMER', kind: 'PITCH_SILENCE', at: fireAt })
    );
    expect(sendItems(h.store, 'taamul_reengage_30d')[0]).toMatchObject({
      status: 'pending',
    });
    h.consent.optIn = false;
    h.sink.fail = () => false;
    expect(await h.runner.drain('B', fireAt)).toMatchObject({ pending: 0 });
    expect(sendItems(h.store, 'taamul_reengage_30d')[0]).toMatchObject({
      status: 'dropped',
      dropReason: 'NO_CONSENT',
    });
    expect(h.sink.sends()).not.toContain('taamul_reengage_30d');
  });
});

describe('F3 a redelivered event drains what a crash left pending', () => {
  it("F3: commit ok, crash before drain, same event again → 'duplicate' and the pending items are delivered once", async () => {
    const h = harness('f1');
    const hi = ev('f1', 'wamid.hi', {
      type: 'INBOUND_TEXT',
      text: 'Hi',
      at: dxb(1, '10:00'),
    });
    const pendingOutbox = h.store.pendingOutbox.bind(h.store);
    let crash = true;
    h.store.pendingOutbox = async (id: string) => {
      if (crash) {
        crash = false;
        throw new Error('process died');
      }
      return pendingOutbox(id);
    };
    await expect(h.runner.handle(hi)).rejects.toThrow('process died');
    expect(h.store.commits).toBe(1);
    expect(h.sink.delivered).toEqual([]);

    expect(await h.runner.handle(hi)).toEqual({ status: 'duplicate' });
    expect(h.sink.sends()).toEqual(['welcome_menu']);
    expect(h.store.outbox.every((i) => i.status === 'delivered')).toBe(true);
    const n = h.sink.delivered.length;
    expect(await h.runner.handle(hi)).toEqual({ status: 'duplicate' });
    expect(h.sink.delivered).toHaveLength(n);
  });
});

describe('F4 POS-only advisor re-issue from PARKED', () => {
  it('F4: LOAN file parked NOT_NOW + ADVISOR QUOTE_READY → WRONG_PRODUCT, file unchanged, no action', () => {
    const sim = new Sim().ev(
      inb(dxb(1, '10:14')),
      btn('LOAN', dxb(1, '10:15')),
      btn('NOT_NOW', dxb(1, '10:16'))
    );
    expect(sim.file).toMatchObject({
      state: 'PARKED',
      product: 'LOAN',
      outcome: { reason: 'NOT_NOW' },
    });
    for (const decision of ['QUOTE_READY', 'COMPARISON_READY'] as const) {
      const r = step(
        def,
        sim.file,
        adv(decision, dxb(2, '10:00'), { validUntil: dxb(5, '12:00') }),
        dxb(2, '10:00'),
        CONSENT
      );
      expect(r.error?.code).toBe('WRONG_PRODUCT');
      expect(r.file).toBe(sim.file);
      expect(r.actions).toEqual([]);
    }
  });
});
