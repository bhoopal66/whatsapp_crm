import { describe, expect, it, vi } from 'vitest';
import {
  createRunner,
  drain,
  type ConsentPort,
  type JourneyFile,
  type OutboxItem,
} from '../index';
import {
  CONSENT_PORT,
  MemorySink,
  MemoryStore,
  Sim,
  btn,
  adv,
  def,
  dxb,
  inb,
  posToDocs,
} from './helpers';

const AT = dxb(5, '09:00');

/** Inbound POS lead in DOCS on day 1, with `items` pending on file f1. */
function harness(
  items: Partial<OutboxItem>[],
  consent: ConsentPort = CONSENT_PORT,
  file: Partial<JourneyFile> = {}
) {
  const store = new MemoryStore({ ...posToDocs(new Sim()).file, ...file });
  items.forEach((i, n) =>
    store.outbox.push({
      id: `i${n + 1}`,
      fileId: 'f1',
      seq: n + 1,
      status: 'pending',
      committedAt: dxb(4, '23:00'),
      ...i,
    } as OutboxItem)
  );
  const sink = new MemorySink();
  const ports = { store, sink, consent };
  return { store, sink, drain: () => drain(ports, 'f1', AT) };
}
type Cat = 'MARKETING' | 'UTILITY' | 'SESSION';
const send = (
  template: string,
  category: Cat,
  extra: { notBefore?: string; state?: string } = {}
) => ({
  action: {
    type: 'SEND' as const,
    template,
    category,
    billable: category !== 'SESSION',
    ...extra,
  },
});
const cost = (template: string, category: Cat) => ({
  action: { type: 'LOG_COST' as const, template, category },
});
const HELD = { notBefore: AT, state: 'DOCS' };
const wroteAt = (at: string): Partial<JourneyFile> => ({
  window: { lastInboundAt: at, freeEntryUntil: null },
});
const outcomes = (s: MemoryStore) =>
  s.outbox.map((i) => i.dropReason ?? i.status);

describe('drain: a MARKETING send and do-not-contact', () => {
  it('is dropped with its LOG_COST; a UTILITY send of the same file still goes', async () => {
    const doNotContact = vi.fn(async () => true);
    const h = harness(
      [
        send('taamul_reengage_30d', 'MARKETING'),
        cost('taamul_reengage_30d', 'MARKETING'),
        send('pos_application_status', 'UTILITY'),
      ],
      { ...CONSENT_PORT, doNotContact }
    );
    expect(await h.drain()).toMatchObject({ dropped: 2, delivered: 1 });
    expect(outcomes(h.store)).toEqual([
      'DO_NOT_CONTACT',
      'SEND_DROPPED',
      'delivered',
    ]);
    expect(doNotContact).toHaveBeenCalledTimes(1);
    expect(doNotContact).toHaveBeenCalledWith('c1');
  });

  it('goes when the customer is not marked', async () => {
    const h = harness([send('taamul_reengage_30d', 'MARKETING')], {
      ...CONSENT_PORT,
      doNotContact: async () => false,
    });
    await h.drain();
    expect(h.sink.sends()).toEqual(['taamul_reengage_30d']);
  });

  it('a register that cannot be read sends nothing: the item stays pending', async () => {
    const h = harness([send('taamul_reengage_30d', 'MARKETING')], {
      ...CONSENT_PORT,
      doNotContact: async () => {
        throw new Error('contacts: timeout');
      },
    });
    const d = await h.drain();
    expect(d.error).toBeInstanceOf(Error);
    expect(d.pending).toBe(1);
    expect(h.sink.attempts).toBe(0);
    expect(outcomes(h.store)).toEqual(['pending']);
  });
});

describe('drain: a send held for quiet hours, once its hour has come', () => {
  for (const [template, category] of [
    ['taamul_reengage_30d', 'MARKETING'],
    ['docs_reminder', 'UTILITY'],
  ] as [string, Cat][]) {
    it(`${category}: dropped with its LOG_COST when the customer wrote after the commit`, async () => {
      const h = harness(
        [send(template, category, HELD), cost(template, category)],
        CONSENT_PORT,
        wroteAt(dxb(4, '23:30'))
      );
      await h.drain();
      expect(outcomes(h.store)).toEqual(['CUSTOMER_WROTE', 'SEND_DROPPED']);
    });

    it(`${category}: dropped when the file has left the state it was committed in`, async () => {
      const h = harness([send(template, category, HELD)], CONSENT_PORT, {
        state: 'SUBMITTED',
      });
      await h.drain();
      expect(outcomes(h.store)).toEqual(['STATE_CHANGED']);
    });

    it(`${category}: goes when neither happened`, async () => {
      const h = harness(
        [send(template, category, HELD)],
        CONSENT_PORT,
        wroteAt(dxb(4, '22:59'))
      );
      await h.drain();
      expect(h.sink.sends()).toEqual([template]);
    });
  }

  it('committed before the state was stamped: judged on the last message alone', async () => {
    const old = send('docs_reminder', 'UTILITY', { notBefore: AT });
    const h = harness([old], CONSENT_PORT, { state: 'SUBMITTED' });
    await h.drain();
    expect(h.sink.sends()).toEqual(['docs_reminder']);
  });

  it('a held opt-in welcome the customer overtook does not use up its claim', async () => {
    const claimOptinWelcome = vi.fn(async () => true);
    const h = harness(
      [send('taamul_optin_welcome', 'MARKETING', HELD)],
      { ...CONSENT_PORT, claimOptinWelcome },
      wroteAt(dxb(4, '23:30'))
    );
    await h.drain();
    expect(outcomes(h.store)).toEqual(['CUSTOMER_WROTE']);
    expect(claimOptinWelcome).not.toHaveBeenCalled();
  });

  it('a reply still waiting (never held) goes, though the customer wrote again and the state moved', async () => {
    const h = harness(
      [
        send('pos_pitch_in_window', 'SESSION'),
        send('pos_docs_request', 'UTILITY'),
      ],
      CONSENT_PORT,
      { ...wroteAt(dxb(5, '08:00')), state: 'SUBMITTED' }
    );
    expect(await h.drain()).toMatchObject({ delivered: 2 });
    expect(h.sink.sends()).toEqual(['pos_pitch_in_window', 'pos_docs_request']);
  });
});

describe('which sends the engine holds', () => {
  it('a timer send at night carries the state; replies to the customer and to an advisor are not held', async () => {
    const t = ['22:50', '22:51', '22:52', '22:55', '23:00'];
    const sim = posToDocs(new Sim(), 1, t).runUntil(dxb(5, '00:00'));
    sim.ev(adv('DOCS_COMPLETE', dxb(5, '00:10')));
    const held = sim.sends().filter((s) => s.notBefore);
    expect(held).toEqual([
      expect.objectContaining({
        template: 'docs_reminder',
        notBefore: AT,
        state: 'DOCS',
      }),
    ]);
    for (const s of sim.sends().filter((x) => !x.notBefore))
      expect(s).not.toHaveProperty('state');
    expect(sim.sends().length).toBeGreaterThan(held.length + 3);
  });

  it('end to end: a cold start at 23:00, the customer writes at 23:30, nothing goes out at 09:00', async () => {
    const file = { ...new Sim().file };
    const store = new MemoryStore(file),
      sink = new MemorySink();
    const runner = createRunner({ def, store, sink, consent: CONSENT_PORT });
    await runner.handle({
      id: 'cold',
      fileId: 'f1',
      type: 'START_COLD',
      at: dxb(1, '23:00'),
    });
    const welcome = store.outbox.find(
      (i) =>
        i.action.type === 'SEND' && i.action.template === 'taamul_optin_welcome'
    )!;
    // Planned before the transition entered S_MENU, so the stamp is the state after the step.
    expect(welcome.action).toMatchObject({ state: 'S_MENU' });
    for (const i of store.outbox) i.committedAt = dxb(1, '23:00');
    await runner.handle({
      id: 'wa:1',
      fileId: 'f1',
      ...inb(dxb(1, '23:30'), 'hello'),
    });
    expect(welcome.status).toBe('pending');
    await runner.drain('f1', dxb(2, '09:00'));
    expect(welcome).toMatchObject({
      status: 'dropped',
      dropReason: 'CUSTOMER_WROTE',
    });
    expect(sink.sends()).toEqual([]);
    // A tap after that is answered at once, at night too.
    await runner.handle({
      id: 'wa:2',
      fileId: 'f1',
      ...btn('POS', dxb(2, '21:00')),
    });
    expect(sink.sends()).toEqual(['pos_pitch_in_window']);
  });
});
