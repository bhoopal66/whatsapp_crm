import { describe, expect, it } from 'vitest';
import { guardrailDetail, guardrailFeedback } from '@/lib/ai/typesafe-gates';
import { regulatorClaims } from './regulator-claim';
import { makeLayer, makeSim } from './test-helpers';

describe('regulatorClaims: central bank status', () => {
  it.each([
    'Taamul is registered with the Central Bank of the UAE.',
    'We are licensed by the CBUAE.',
    'Yes, we are regulated by the Central Bank of the U.A.E. and work with partner banks.',
    'Our firm is authorised by the UAE Central Bank.',
    'We operate under the supervision of the Central Bank.',
    'Rest assured, our services are approved by the CBUAE!',
    'Fully licensed by the Central Bank of the UAE.',
    'The Central Bank licenses us to arrange business loans.',
    'نحن مرخصون من المصرف المركزي.',
    'شركة تعامل مسجلة لدى مصرف الإمارات العربية المتحدة المركزي',
    'تعامل خاضعة لرقابة البنك المركزي الإماراتي',
    'مرخصة من مصرف الامارات المركزي',
  ])('fires on %s', (draft) => {
    expect(regulatorClaims(draft)).toEqual(['regulator']);
  });

  it.each([
    'The bank decides on every application.',
    'Central Bank holiday rules mean the branch is closed on Monday.',
    'Mashreq is regulated by the Central Bank.',
    'All UAE banks are licensed by the CBUAE.',
    'بنك المشرق مرخص من المصرف المركزي',
    'Please bring your trade licence; the Central Bank AECB report is pulled by the bank.',
    // Regulator and status word in different sentences.
    'The Central Bank sets the rules. We are a licensed broker.',
  ])('does not fire on %s', (draft) => {
    expect(regulatorClaims(draft)).toEqual([]);
  });

  it('holds when the sentence also refers to us, even about a bank', () => {
    // Cannot be told apart from a claim about ourselves: a person reviews.
    expect(
      regulatorClaims('We work with banks regulated by the Central Bank.')
    ).toEqual(['regulator']);
  });
});

describe('regulatorClaims: bank or lender', () => {
  it.each([
    'Taamul is a bank.',
    "We're a licensed lender in Dubai.",
    'We are the lender for this facility.',
    'We lend up to the amount you need.',
    "We'll lend you the money directly.",
    'Taamul lends to small businesses.',
    'نحن بنك في دبي',
    'نحن جهة إقراض',
    'ونقرضك المبلغ مباشرة',
  ])('fires on %s', (draft) => {
    expect(regulatorClaims(draft)).toEqual(['bank_or_lender']);
  });

  it.each([
    'We are not a bank.',
    "We're a broker, not a bank.",
    'We are a bank partner for Mashreq.',
    "We are the bank's Direct Sales Agent.",
    "We don't lend; the bank does.",
    'We offer business loans from our partner banks.',
    'لسنا بنكاً، نحن وسيط مالي',
    'نحن لا نقرض',
  ])('does not fire on %s', (draft) => {
    expect(regulatorClaims(draft)).toEqual([]);
  });

  it('reports both kinds once', () => {
    expect(
      regulatorClaims(
        'We are a bank. We are licensed by the CBUAE. Taamul is a lender.'
      ).sort()
    ).toEqual(['bank_or_lender', 'regulator']);
  });
});

describe('guardrail: CODE_REGULATOR_CLAIM', () => {
  const claim = 'Taamul is licensed by the Central Bank of the UAE.';

  it('holds the draft with the reason code, on and live', async () => {
    const { layer } = makeLayer({ sim: makeSim() });
    const d = await layer.guardrail({
      customerMessage: 'Are you regulated?',
      botReply: claim,
      evidence: [],
    });
    expect(d).toMatchObject({
      act: true,
      outcome: 'hold',
      rmTaskReason: 'GUARDRAIL_REVIEW',
    });
    expect(d.reasonCodes).toContain('CODE_REGULATOR_CLAIM');
    expect(d.hazards).toContainEqual({
      hazard: 'regulator_claim',
      value: 1,
      source: 'code',
    });
  });

  it('still holds when the evidence makes the same claim', async () => {
    const { layer } = makeLayer({ sim: makeSim() });
    const d = await layer.guardrail({
      customerMessage: 'Are you regulated?',
      botReply: claim,
      evidence: [{ id: 'k1', text: claim }],
      context: [claim],
    });
    expect(d.outcome).toBe('hold');
    expect(d.reasonCodes).toContain('CODE_REGULATOR_CLAIM');
  });

  it("never fires on the customer's text", async () => {
    const { layer } = makeLayer({ sim: makeSim() });
    const d = await layer.guardrail({
      customerMessage: 'Are you a bank licensed by the CBUAE?',
      botReply: 'We are a Dubai-based financial broking firm.',
      evidence: [],
    });
    expect(d.outcome).toBe('send');
    expect(d.reasonCodes).not.toContain('CODE_REGULATOR_CLAIM');
  });

  it('holds with TypeSafe down, like the other code checks', async () => {
    const { layer } = makeLayer({
      sim: makeSim(() => ({ status: 500 })),
      config: { guardrailFailMode: 'send' },
    });
    const d = await layer.guardrail({
      customerMessage: 'Hi',
      botReply: claim,
      evidence: [],
    });
    expect(d).toMatchObject({ act: true, outcome: 'hold' });
    expect(d.reasonCodes).toContain('CODE_REGULATOR_CLAIM');
  });

  it('acts in a held-back reply language, as a code check', async () => {
    const { layer } = makeLayer({
      sim: makeSim(),
      config: { shadowLanguages: ['ar'] },
    });
    const d = await layer.guardrail({
      customerMessage: 'هل أنتم مرخصون؟',
      botReply: 'نحن مرخصون من المصرف المركزي.',
      evidence: [],
    });
    expect(d).toMatchObject({ act: true, outcome: 'hold' });
    expect(d.reasonCodes).toEqual(
      expect.arrayContaining([
        'CODE_REGULATOR_CLAIM',
        'LANGUAGE_SHADOW_CODE_ONLY',
      ])
    );
  });

  it('changes nothing in monitor mode (act: false)', async () => {
    const { layer } = makeLayer({
      sim: makeSim(),
      config: { shadowOverride: { guardrail: true } },
    });
    const d = await layer.guardrail({
      customerMessage: 'Hi',
      botReply: claim,
      evidence: [],
    });
    expect(d.act).toBe(false);
    expect(d.reasonCodes).toContain('CODE_REGULATOR_CLAIM');
  });
});

describe('gates: CODE_REGULATOR_CLAIM wording', () => {
  it('tells the rewrite what to say instead', () => {
    const f = guardrailFeedback(['CODE_REGULATOR_CLAIM']);
    expect(f).toContain('Central Bank of the UAE (CBUAE)');
    expect(f).toContain(
      'describe Taamul as a Dubai-based financial broking firm and Direct Sales Agent working with UAE partner banks'
    );
    expect(f).not.toContain('using only facts from the knowledge excerpts');
  });

  it('explains the hold in the hand-off note', () => {
    expect(guardrailDetail('hold', ['CODE_REGULATOR_CLAIM'], 'x')).toBe(
      'the safety check held the draft reply because the draft described the business as registered with, licensed or regulated by the Central Bank of the UAE (CBUAE), or as a bank or lender, which it must never say. (code: CODE_REGULATOR_CLAIM) Draft: “x”'
    );
  });
});
