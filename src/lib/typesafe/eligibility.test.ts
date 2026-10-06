import { describe, expect, it } from 'vitest';
import {
  extractAmountCandidates,
  extractYearsCandidates,
} from './questions/eligibility';
import { bandFor } from './checks/eligibility';
import { redact } from './redact';
import { makeLayer, makeSim } from './test-helpers';

const sectors = {
  general_trading: 'General trading, import and export of goods.',
  contracting: 'Construction and contracting.',
  it_services: 'IT and software services.',
  restaurants: 'Restaurants, cafés and food service.',
};

describe('candidate extraction (code side)', () => {
  it('finds AED amounts in English and Arabic forms', () => {
    const c = extractAmountCandidates([
      { n: 1, text: 'Our turnover is around AED 4.2m and we need a 500k loan' },
      { n: 2, text: 'المبيعات السنوية ٣ مليون درهم' },
      { n: 3, text: 'Revenue last year 12,500,000 dirhams' },
    ]);
    expect(c.map((x) => x.value)).toEqual([
      4_200_000, 500_000, 3_000_000, 12_500_000,
    ]);
    expect(c.map((x) => x.key)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(c[2]!.messageNo).toBe(2);
  });

  it('ignores years, small counts, and redacted phone numbers', () => {
    const text = redact('Since 2019 we have 12 staff, call 0501234567').text;
    expect(extractAmountCandidates([{ n: 1, text }])).toEqual([]);
  });

  it('finds years in business from durations and founding years', () => {
    const c = extractYearsCandidates(
      [
        { n: 1, text: 'We have been operating for 6 years' },
        { n: 2, text: 'established in 2021' },
        { n: 3, text: 'تأسست الشركة منذ 2015' },
      ],
      2026
    );
    expect(c.map((x) => x.value)).toEqual([6, 5, 11]);
  });

  it('bands turnover in code', () => {
    expect(bandFor(999_999)).toBe('below AED 1m');
    expect(bandFor(1_000_000)).toBe('AED 1m–3m');
    expect(bandFor(4_200_000)).toBe('AED 3m–10m');
    expect(bandFor(75_000_000)).toBe('AED 50m and above');
  });
});

describe('check E — eligibility capture', () => {
  const conversation = [
    { from: 'taamul' as const, text: 'What is your annual turnover?' },
    {
      from: 'customer' as const,
      text: 'We are a Dubai LLC in general trading, turnover AED 4.2m, need a 500k loan',
    },
    { from: 'customer' as const, text: 'Operating 6 years, licence valid' },
  ];

  it('selects candidates, converts in code, and fills all fields', async () => {
    const sim = makeSim(() => ({
      answers: {
        emirate: 'dubai',
        legal_form: 'llc',
        sector: 'general_trading',
        turnover_candidate: { choice: 'c1', confidence: 0.85 },
        years_candidate: 'c1',
        trade_licence: 'holds_licence',
      },
    }));
    const { layer } = makeLayer({ sim });
    const d = await layer.eligibility({
      conversation,
      sectors,
      currentYear: 2026,
    });
    expect(d.emirate).toMatchObject({ value: 'dubai', reask: false });
    expect(d.legalForm.value).toBe('llc');
    expect(d.sector.value).toBe('general_trading');
    expect(d.turnover.value).toEqual({ aed: 4_200_000, band: 'AED 3m–10m' });
    expect(d.yearsInBusiness.value).toBe(6);
    expect(d.hasTradeLicence.value).toBe(true);
    expect(d.reasonCodes).toEqual([]);
    // Candidates offered as Choice options, with a none option
    const q = sim.calls[0]!.body.questions.turnover_candidate!;
    expect(Object.keys(q.criteria as object)).toEqual([
      'c1',
      'c2',
      'none_is_turnover',
    ]);
  });

  it('re-asks on low confidence, not_stated, none, and unclear licence — never guesses', async () => {
    const sim = makeSim(() => ({
      answers: {
        emirate: { choice: 'sharjah', confidence: 0.4 },
        legal_form: 'not_stated',
        sector: 'general_trading',
        turnover_candidate: 'none_is_turnover',
        years_candidate: 'c1',
        trade_licence: 'not_stated',
      },
    }));
    const { layer } = makeLayer({ sim });
    const d = await layer.eligibility({
      conversation,
      sectors,
      currentYear: 2026,
    });
    expect(d.emirate).toMatchObject({
      value: null,
      reask: true,
      confidence: 0.4,
    });
    expect(d.legalForm.reask).toBe(true);
    expect(d.turnover.reask).toBe(true);
    expect(d.hasTradeLicence).toMatchObject({ value: null, reask: true });
    expect(d.reasonCodes).toEqual(
      expect.arrayContaining([
        'REASK_emirate',
        'REASK_legalForm',
        'REASK_turnover',
        'REASK_hasTradeLicence',
      ])
    );
  });

  it('omits candidate questions when there are no candidates', async () => {
    const sim = makeSim(() => ({}));
    const { layer } = makeLayer({ sim });
    const d = await layer.eligibility({
      conversation: [{ from: 'customer', text: 'hi, open an account' }],
      sectors,
      currentYear: 2026,
    });
    const qs = Object.keys(sim.calls[0]!.body.questions);
    expect(qs).not.toContain('turnover_candidate');
    expect(qs).not.toContain('years_candidate');
    expect(d.turnover.reask).toBe(true);
  });

  it('maps host sector keys that collide with reserved options, and never throws', async () => {
    const sim = makeSim(() => ({ answers: { sector: 'other_sector' } }));
    const { layer } = makeLayer({ sim });
    const d = await layer.eligibility({
      conversation,
      sectors: { other: 'Other trading activity', it_services: 'IT' },
      currentYear: 2026,
    });
    expect(
      Object.keys(sim.calls[0]!.body.questions.sector!.criteria as object)
    ).toEqual(['other_sector', 'it_services', 'other', 'not_stated']);
    expect(d.sector.value).toBe('other'); // host's own key
    const big = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`s${i}`, `sector ${i}`])
    );
    const d2 = await layer.eligibility({
      conversation,
      sectors: big,
      currentYear: 2026,
    });
    expect(d2.sector.reask).toBe(true);
    expect(Object.keys(sim.calls[1]!.body.questions)).not.toContain('sector');
  });

  it('never stores customer text from candidate snippets in the log', async () => {
    const logged: unknown[] = [];
    const sim = makeSim(() => ({ answers: { turnover_candidate: 'c1' } }));
    const { layer } = makeLayer({
      sim,
      store: {
        activePolicy: async () => null,
        insertDecision: async (row) => {
          logged.push(row);
          return 'x';
        },
      },
    });
    await layer.eligibility({
      conversation: [
        {
          from: 'customer',
          text: 'I am Ahmed Khalid from Khalid Trading, turnover about AED 5m',
        },
      ],
      sectors,
      currentYear: 2026,
    });
    const all = JSON.stringify(logged);
    expect(all).not.toContain('Khalid');
    expect(all).toContain('5000000');
  });

  it('falls back to re-asking everything when TypeSafe fails', async () => {
    const sim = makeSim(() => ({ status: 500 }));
    const { layer } = makeLayer({ sim });
    const d = await layer.eligibility({
      conversation,
      sectors,
      currentYear: 2026,
    });
    expect(d.fallbackUsed).toBe(true);
    for (const f of [
      d.emirate,
      d.legalForm,
      d.sector,
      d.turnover,
      d.yearsInBusiness,
      d.hasTradeLicence,
    ])
      expect(f.reask).toBe(true);
  });
});
