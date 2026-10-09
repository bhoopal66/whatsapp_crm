import { describe, expect, it, vi } from 'vitest';
import type { RouteJudgment } from '@/lib/typesafe';
import {
  nextTierUp,
  resolveTierModel,
  routeMessage,
  tierFromHeuristic,
  tierFromJudgment,
  type RouteOk,
  type RouterModelConfig,
} from './router';

const KINDS = [
  'greeting_or_thanks',
  'simple_question',
  'detailed_question',
  'multi_part_or_reasoning',
  'sensitive_or_negotiation',
  'unclear',
] as const;
type Kind = (typeof KINDS)[number];

function judgment(
  over: {
    label?: Kind;
    p?: Partial<Record<Kind, number>>;
    complexity?: number;
    needsFacts?: number;
  } = {}
): RouteOk {
  const label = over.label ?? 'simple_question';
  const p = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<
    Kind,
    number
  >;
  p[label] = 0.9;
  Object.assign(p, over.p);
  return {
    ok: true,
    kind: { label, p },
    complexity: over.complexity ?? 1,
    needsFacts: over.needsFacts ?? 0.5,
    latencyMs: 10,
  } as RouteOk;
}

const FREE = { inFlow: false };
const IN_FLOW = { inFlow: true };

describe('tierFromJudgment', () => {
  it('large when multi-part plus sensitive mass reaches 0.5 (inclusive)', () => {
    const at = judgment({
      p: { multi_part_or_reasoning: 0.25, sensitive_or_negotiation: 0.25 },
    });
    expect(tierFromJudgment(at, FREE).tier).toBe('large');
    const below = judgment({
      p: { multi_part_or_reasoning: 0.25, sensitive_or_negotiation: 0.24 },
    });
    expect(tierFromJudgment(below, FREE).tier).toBe('standard');
  });

  it('large when complexity reaches 2.0 (inclusive)', () => {
    expect(tierFromJudgment(judgment({ complexity: 2.0 }), FREE).tier).toBe(
      'large'
    );
    expect(tierFromJudgment(judgment({ complexity: 1.99 }), FREE).tier).toBe(
      'standard'
    );
  });

  it('tests large first: a confident greeting that is complex is large', () => {
    const j = judgment({
      label: 'greeting_or_thanks',
      complexity: 2.5,
      needsFacts: 0.1,
    });
    expect(tierFromJudgment(j, FREE).tier).toBe('large');
  });

  it('small for a greeting at p 0.7 (inclusive), needsFacts under 0.3', () => {
    const base = { label: 'greeting_or_thanks' as const, needsFacts: 0.1 };
    expect(
      tierFromJudgment(
        judgment({ ...base, p: { greeting_or_thanks: 0.7 } }),
        FREE
      ).tier
    ).toBe('small');
    expect(
      tierFromJudgment(
        judgment({ ...base, p: { greeting_or_thanks: 0.69 } }),
        FREE
      ).tier
    ).toBe('standard');
  });

  it('needsFacts 0.3 is not small (exclusive); 0.29 is, and skips knowledge', () => {
    const at = tierFromJudgment(
      judgment({ label: 'greeting_or_thanks', needsFacts: 0.3 }),
      FREE
    );
    expect(at).toMatchObject({ tier: 'standard', skipKnowledge: false });
    const under = tierFromJudgment(
      judgment({ label: 'greeting_or_thanks', needsFacts: 0.29 }),
      FREE
    );
    expect(under).toMatchObject({ tier: 'small', skipKnowledge: true });
  });

  it('never small inside a flow', () => {
    const j = judgment({ label: 'greeting_or_thanks', needsFacts: 0.1 });
    expect(tierFromJudgment(j, IN_FLOW)).toMatchObject({
      tier: 'standard',
      skipKnowledge: false,
    });
  });

  it('unclear and ordinary questions are standard', () => {
    expect(
      tierFromJudgment(judgment({ label: 'unclear', needsFacts: 0 }), FREE).tier
    ).toBe('standard');
    expect(tierFromJudgment(judgment(), FREE).tier).toBe('standard');
  });

  it('does not skip knowledge for a non-small tier', () => {
    expect(
      tierFromJudgment(judgment({ complexity: 3, needsFacts: 0 }), FREE)
        .skipKnowledge
    ).toBe(false);
  });
});

describe('tierFromHeuristic', () => {
  const tier = (text: string, ctx = FREE) => tierFromHeuristic(text, ctx).tier;

  it.each([
    'hello',
    'Thanks!',
    'thank you so much',
    'good morning team',
    'ok',
    'السلام عليكم',
    'مرحبا',
    'شكراً',
    'شكرًا جزيلا',
    'أهلاً',
    'السّلام عليكم ورحمة الله',
    '👍',
    '🙏🙏',
    '👍🏽',
    'thanks 🙏',
  ])('small: %s', (text) => {
    const d = tierFromHeuristic(text, FREE);
    expect(d.tier).toBe('small');
    expect(d.skipKnowledge).toBe(true);
  });

  it('normalises Arabic: alef variants, ى, ة, diacritics, tatweel', () => {
    expect(tier('أهلا')).toBe('small'); // alef hamza -> alef
    expect(tier('إهلا')).toBe('small');
    expect(tier('آهلا')).toBe('small');
    expect(tier('شكرا')).toBe('small');
    expect(tier('شكراً')).toBe('small'); // tanween
    expect(tier('مرحـــبا')).toBe('small'); // tatweel
    expect(tier('مشكوره')).toBe('small'); // ة -> ه
    expect(tier('مشكورة')).toBe('small');
  });

  it('five words may be small, six may not', () => {
    expect(tier('thanks thanks thanks thanks thanks')).toBe('small');
    expect(tier('thanks thanks thanks thanks thanks thanks')).toBe('standard');
  });

  it('a greeting plus a real question is not small', () => {
    expect(tier('hello what are your fees')).toBe('standard');
    expect(tier('مرحبا كم السعر')).toBe('standard');
  });

  it('never small inside a flow', () => {
    expect(tier('hello', IN_FLOW)).toBe('standard');
    expect(tier('السلام عليكم', IN_FLOW)).toBe('standard');
    expect(tier('👍', IN_FLOW)).toBe('standard');
  });

  it('large above 60 words (61), standard at exactly 60', () => {
    const words = (n: number) => Array(n).fill('word').join(' ');
    expect(tier(words(60))).toBe('standard');
    expect(tier(words(61))).toBe('large');
  });

  it('large for two question marks, including ؟ plus ?', () => {
    expect(tier('how much? and when?')).toBe('large');
    expect(tier('كم السعر؟ and when?')).toBe('large');
    expect(tier('كم السعر؟ ومتى؟')).toBe('large');
  });

  it('a run of question marks counts once', () => {
    expect(tier('how much??')).toBe('standard');
    expect(tier('how much???')).toBe('standard');
    expect(tier('كم السعر؟؟')).toBe('standard');
    expect(tier('how much?؟')).toBe('standard');
    expect(tier('how much??  and when?')).toBe('large');
  });

  it('a lone question is standard and keeps knowledge on', () => {
    expect(tierFromHeuristic('what is the fee?', FREE)).toMatchObject({
      tier: 'standard',
      skipKnowledge: false,
    });
  });

  it('large applies in a flow too', () => {
    expect(tier('a? b?', IN_FLOW)).toBe('large');
  });
});

describe('resolveTierModel', () => {
  const cfg = (over: Partial<RouterModelConfig> = {}): RouterModelConfig => ({
    model: 'std',
    modelSmall: 'sm',
    modelLarge: 'lg',
    modelRouting: true,
    ...over,
  });

  it('routing off: always the account model, requested tier kept', () => {
    for (const t of ['small', 'standard', 'large'] as const)
      expect(resolveTierModel(cfg({ modelRouting: false }), t)).toEqual({
        tier: t,
        model: 'std',
      });
  });

  it('picks the tier model', () => {
    expect(resolveTierModel(cfg(), 'small')).toEqual({
      tier: 'small',
      model: 'sm',
    });
    expect(resolveTierModel(cfg(), 'standard')).toEqual({
      tier: 'standard',
      model: 'std',
    });
    expect(resolveTierModel(cfg(), 'large')).toEqual({
      tier: 'large',
      model: 'lg',
    });
  });

  it('falls back to the account model, keeping the requested tier', () => {
    const c = cfg({ modelSmall: null, modelLarge: null });
    expect(resolveTierModel(c, 'small')).toEqual({
      tier: 'small',
      model: 'std',
    });
    expect(resolveTierModel(c, 'large')).toEqual({
      tier: 'large',
      model: 'std',
    });
  });
});

describe('nextTierUp', () => {
  it('small -> standard -> large -> null', () => {
    expect(nextTierUp('small')).toBe('standard');
    expect(nextTierUp('standard')).toBe('large');
    expect(nextTierUp('large')).toBeNull();
  });
});

describe('routeMessage', () => {
  const config: RouterModelConfig = {
    model: 'std',
    modelSmall: 'sm',
    modelLarge: 'lg',
    modelRouting: true,
  };
  const base = {
    accountId: 'acct',
    journeyStage: 'open_conversation',
    ctx: FREE,
  };

  it('routing off: never calls the judge', async () => {
    const judge = vi.fn();
    const r = await routeMessage({
      ...base,
      config: { ...config, modelRouting: false },
      message: 'hello',
      judge,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      tier: 'standard',
      model: 'std',
      source: 'fixed',
      skipKnowledge: false,
    });
  });

  it('source jev on success, model from the judged tier', async () => {
    const judge = vi.fn(async () =>
      judgment({ label: 'greeting_or_thanks', needsFacts: 0.1 })
    );
    const r = await routeMessage({ ...base, config, message: 'hi', judge });
    expect(judge).toHaveBeenCalledOnce();
    expect(r).toMatchObject({
      tier: 'small',
      model: 'sm',
      source: 'jev',
      skipKnowledge: true,
    });
  });

  it('falls back to the heuristic when the judge returns ok:false', async () => {
    const judge = async (): Promise<RouteJudgment> => ({
      ok: false,
      errorCode: 'DISABLED',
      latencyMs: 0,
    });
    const r = await routeMessage({ ...base, config, message: 'hello', judge });
    expect(r).toMatchObject({
      tier: 'small',
      model: 'sm',
      source: 'heuristic',
    });
    expect(r.detail).toContain('DISABLED');
  });

  it('falls back to the heuristic when the judge throws', async () => {
    const judge = async (): Promise<RouteJudgment> => {
      throw new Error('boom');
    };
    const r = await routeMessage({
      ...base,
      config,
      message: 'a? b?',
      judge,
    });
    expect(r).toMatchObject({
      tier: 'large',
      model: 'lg',
      source: 'heuristic',
    });
  });

  it('heuristic fallback respects inFlow', async () => {
    const judge = async (): Promise<RouteJudgment> => ({
      ok: false,
      errorCode: 'DISABLED',
      latencyMs: 0,
    });
    const r = await routeMessage({
      ...base,
      ctx: IN_FLOW,
      config,
      message: 'hello',
      judge,
    });
    expect(r).toMatchObject({ tier: 'standard', source: 'heuristic' });
  });
});
