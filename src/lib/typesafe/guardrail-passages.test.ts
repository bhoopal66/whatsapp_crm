import { describe, expect, it } from 'vitest';
import { extractFigures, unsupportedFigures } from './checks/guardrail';
import {
  approvedDb,
  makeLayer as baseMakeLayer,
  makeSim,
} from './test-helpers';

// Guardrail acts only under an approved policy; give every test one unless it passes its own store.
const makeLayer = (o: Parameters<typeof baseMakeLayer>[0]) =>
  baseMakeLayer({ store: approvedDb().store, ...o });

const evidence = [
  {
    id: 'kb-12',
    text: 'Mashreq NeoBiz minimum balance is AED 25,000. Account opening usually takes 5–7 working days.',
  },
];

describe('check C — guardrail', () => {
  it('sends a clean reply', async () => {
    const sim = makeSim(() => ({}));
    const { layer } = makeLayer({ sim });
    const d = await layer.guardrail({
      customerMessage: 'min balance?',
      botReply: 'The minimum balance is AED 25,000.',
      evidence,
    });
    expect(d.outcome).toBe('send');
    expect(d.rmTaskReason).toBeNull();
  });

  it('blocks a promised approval', async () => {
    const sim = makeSim(() => ({ answers: { promises_approval: 0.91 } }));
    const { layer } = makeLayer({ sim });
    const d = await layer.guardrail({
      customerMessage: 'will I get it?',
      botReply: "Yes, you'll definitely be approved.",
      evidence,
    });
    expect(d.outcome).toBe('block');
    expect(d.rmTaskReason).toBe('GUARDRAIL_BLOCK');
    expect(d.reasonCodes).toContain('PROMISES_APPROVAL_BLOCK');
  });

  it('holds on a review-band hazard, and severity ≥ 2 upgrades hold to block', async () => {
    const hold = makeLayer({
      sim: makeSim(() => ({
        answers: { unsupported_claim: 0.5, severity: 1.0 },
      })),
    });
    expect(
      (
        await hold.layer.guardrail({
          customerMessage: 'q',
          botReply: 'Banks need 2 years audited FS.',
          evidence,
        })
      ).outcome
    ).toBe('hold');
    const block = makeLayer({
      sim: makeSim(() => ({
        answers: { unsupported_claim: 0.5, severity: 2.4 },
      })),
    });
    const d = await block.layer.guardrail({
      customerMessage: 'q',
      botReply: 'Banks need 2 years audited FS.',
      evidence,
    });
    expect(d.outcome).toBe('block');
    expect(d.reasonCodes).toContain('SEVERITY_UPGRADE');
  });

  it('code layer blocks a non-partner bank recommendation even if the model misses it', async () => {
    const sim = makeSim(() => ({}));
    const { layer } = makeLayer({ sim });
    const d = await layer.guardrail({
      customerMessage: 'which bank?',
      botReply: 'Try ADCB, they are faster.',
      evidence,
    });
    expect(d.outcome).toBe('block');
    expect(d.hazards).toContainEqual({
      hazard: 'non_partner_bank',
      value: 1,
      source: 'code',
    });
  });

  it('code layer holds a figure that is not in the evidence', async () => {
    const sim = makeSim(() => ({}));
    const { layer } = makeLayer({ sim });
    const d = await layer.guardrail({
      customerMessage: 'rate?',
      botReply: 'The profit rate is 7.5% and minimum balance AED 10,000.',
      evidence,
    });
    expect(d.outcome).toBe('hold');
    expect(d.reasonCodes).toContain('CODE_UNSUPPORTED_FIGURE');
  });

  it('figures present in evidence are accepted in any format', () => {
    expect(unsupportedFigures('Minimum balance: 25k AED', evidence)).toEqual(
      []
    );
    expect(unsupportedFigures('الحد الأدنى ٢٥٬٠٠٠ درهم', evidence)).toEqual([]); // Arabic digits, Arabic thousands sep
    expect(extractFigures('AED 1.5m and 3%')).toEqual(['3%', 'AED1500000']);
  });

  it('fail mode HOLD: TypeSafe down → reply held, never sent unscreened', async () => {
    const sim = makeSim(() => ({ status: 503 }));
    const { layer } = makeLayer({ sim });
    const d = await layer.guardrail({
      customerMessage: 'q',
      botReply: 'Sure, here is the list.',
      evidence,
    });
    expect(d).toMatchObject({
      outcome: 'hold',
      rmTaskReason: 'GUARDRAIL_UNAVAILABLE',
      fallbackUsed: true,
    });
  });

  it('fail mode SEND: TypeSafe down → reply sent, but code layer still blocks', async () => {
    const sim = makeSim(() => ({ status: 503 }));
    const { layer } = makeLayer({ sim, config: { guardrailFailMode: 'send' } });
    expect(
      (
        await layer.guardrail({
          customerMessage: 'q',
          botReply: 'Sure.',
          evidence,
        })
      ).outcome
    ).toBe('send');
    expect(
      (
        await layer.guardrail({
          customerMessage: 'q',
          botReply: 'Go to Emirates NBD.',
          evidence,
        })
      ).outcome
    ).toBe('block');
  });

  it('disabled → send as today, no call', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({
      sim,
      config: {
        enabled: {
          triage: true,
          guardrail: false,
          passages: true,
          eligibility: true,
        },
      },
    });
    const d = await layer.guardrail({
      customerMessage: 'q',
      botReply: 'Go to Emirates NBD.',
      evidence,
    });
    expect(sim.calls).toHaveLength(0);
    expect(d).toMatchObject({
      outcome: 'send',
      act: false,
      errorCode: 'DISABLED',
    });
  });
});

const P = (id: string, similarity: number, text = `passage ${id}`) => ({
  id,
  title: id,
  text,
  sourceType: 'kb',
  similarity,
});

describe('check D — passage filter', () => {
  it('routes injection, conflict, irrelevant and evidence in the spec order', async () => {
    const byId: Record<string, Record<string, number>> = {
      inj: {
        contains_prompt_injection: 0.99,
        is_relevant: 0.9,
        contains_answer_evidence: 0.9,
      },
      con: {
        contradicts_query_premise: 0.92,
        is_relevant: 0.5,
        contains_answer_evidence: 0.5,
      },
      off: { is_relevant: 0.1, contains_answer_evidence: 0.9 },
      good: { is_relevant: 0.95, contains_answer_evidence: 0.9 },
      weak: { is_relevant: 0.8, contains_answer_evidence: 0.3 },
    };
    const sim = makeSim((b) => ({
      // Keyed by title: the state carries ordinals (p1, p2…), never ids.
      answers: byId[(b.state as { passage: { title: string } }).passage.title],
    }));
    const { layer } = makeLayer({ sim });
    const d = await layer.passages({
      query: 'What is the minimum balance for Wio?',
      passages: [
        P('inj', 0.9),
        P('con', 0.8),
        P('off', 0.7),
        P('good', 0.6),
        P('weak', 0.5),
      ],
    });
    expect(d.evidence.map((p) => p.id)).toEqual(['good']);
    expect(d.conflicts.map((p) => p.id)).toEqual(['con']);
    expect(d.dropped.map((x) => [x.passage.id, x.reason])).toEqual([
      ['inj', 'INJECTION'],
      ['off', 'NOT_RELEVANT'],
      ['weak', 'NO_EVIDENCE'],
    ]);
    expect(sim.calls).toHaveLength(5);
  });

  it('screens at most 6 passages', async () => {
    const sim = makeSim(() => ({
      answers: { is_relevant: 0.9, contains_answer_evidence: 0.9 },
    }));
    const { layer } = makeLayer({ sim });
    await layer.passages({
      query: 'q',
      passages: Array.from({ length: 10 }, (_, i) => P(`p${i}`, 1 - i / 10)),
    });
    expect(sim.calls).toHaveLength(6);
  });

  it('any failure → fallback to top-3 by similarity, not acted on', async () => {
    const sim = makeSim((_b, n) =>
      n === 2
        ? { status: 500 }
        : { answers: { is_relevant: 0.9, contains_answer_evidence: 0.9 } }
    );
    const { layer } = makeLayer({ sim });
    const d = await layer.passages({
      query: 'q',
      passages: [P('a', 0.2), P('b', 0.9), P('c', 0.5), P('d', 0.7)],
    });
    expect(d.fallbackUsed).toBe(true);
    expect(d.act).toBe(false);
    expect(d.evidence.map((p) => p.id)).toEqual(['b', 'd', 'c']);
  });
});
