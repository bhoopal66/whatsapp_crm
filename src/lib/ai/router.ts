import { getDecisionLayer } from '@/lib/typesafe';
import type { RouteInput, RouteJudgment } from '@/lib/typesafe';

// ============================================================
// Model-tier router for the auto-reply bot: which of three models
// answers one inbound customer message. `small` for greetings and
// thanks, `standard` (the account's model) for ordinary questions,
// `large` for multi-part, sensitive or negotiation messages.
//
// The judgment comes from TypeSafe's Jev (`DecisionLayer.route`, one
// request, never throws); when it is unavailable a cheap heuristic
// decides. Everything here but `routeMessage`'s default judge is pure.
// ============================================================

/** Mirrors `AiReplyTier` (lib/ai/outcomes.ts); identical members. */
export type RouterTier = 'small' | 'standard' | 'large';
/** Mirrors `AiRouteSource` (lib/ai/outcomes.ts); identical members. */
export type RouterSource = 'jev' | 'heuristic' | 'fixed';

export interface RouterContext {
  /** The conversation is inside a guided flow: never the small model. */
  inFlow: boolean;
}

export interface TierDecision {
  tier: RouterTier;
  /** A greeting or thanks needs no knowledge: the caller may skip
   *  retrieval (and its embedding cost). */
  skipKnowledge: boolean;
  /** Short, for logs. Never customer text. */
  detail: string;
}

export type RouteOk = Extract<RouteJudgment, { ok: true }>;

/** Jev thresholds. */
const SMALL_KIND_MIN = 0.7;
const SMALL_FACTS_MAX = 0.3;
const LARGE_MASS_MIN = 0.5;
const LARGE_COMPLEXITY_MIN = 2.0;

/**
 * Tier from a Jev judgment. `large` is tested first: a judgment that
 * calls a message a greeting yet rates it complex is contradictory, and
 * the more capable model is the safe side of that doubt. An `unclear`
 * message gets the standard model unless the large rules hold.
 */
export function tierFromJudgment(j: RouteOk, ctx: RouterContext): TierDecision {
  const label = j.kind.label;
  const p = j.kind.p;
  const detail = `jev ${label} ${(p[label] ?? 0).toFixed(2)}, complexity ${j.complexity.toFixed(1)}, facts ${j.needsFacts.toFixed(2)}`;
  const heavy =
    (p.multi_part_or_reasoning ?? 0) + (p.sensitive_or_negotiation ?? 0);
  let tier: RouterTier = 'standard';
  if (heavy >= LARGE_MASS_MIN || j.complexity >= LARGE_COMPLEXITY_MIN)
    tier = 'large';
  else if (
    label === 'greeting_or_thanks' &&
    (p.greeting_or_thanks ?? 0) >= SMALL_KIND_MIN &&
    j.needsFacts < SMALL_FACTS_MAX &&
    !ctx.inFlow
  )
    tier = 'small';
  return {
    tier,
    skipKnowledge: tier === 'small' && j.needsFacts < SMALL_FACTS_MAX,
    detail,
  };
}

// ------------------------------------------------------------
// Heuristic (Jev unavailable)
// ------------------------------------------------------------

const SMALL_MAX_WORDS = 5;
const LARGE_MIN_WORDS = 60;

/**
 * Greeting / thanks / acknowledgement phrases, matched after
 * `normalise` (lower case, Arabic letter variants folded, diacritics and
 * tatweel removed). Longest first, so "thank you" wins over "thank".
 */
const CORE_PHRASES = [
  // English
  'good morning',
  'good afternoon',
  'good evening',
  'thank you',
  'thanks',
  'thank u',
  'thanx',
  'thx',
  'ty',
  'many thanks',
  'much appreciated',
  'appreciated',
  'hello',
  'hi',
  'hey',
  'hiya',
  'morning',
  'ok',
  'okay',
  'okey',
  'k',
  'noted',
  'got it',
  'alright',
  'all right',
  'great',
  'perfect',
  'cool',
  'bye',
  'goodbye',
  // Transliterated Arabic
  'assalamu alaikum',
  'assalamualaikum',
  'assalam alaikum',
  'asalamu alaikum',
  'asalam alaikum',
  'salam alaikum',
  'salamu alaikum',
  'as salamu alaykum',
  'salam',
  'salaam',
  'shukran',
  'marhaba',
  'ahlan',
  'yalla',
  // Arabic (normalised: ا for أإآ, ي for ى, ه for ة)
  'السلام عليكم',
  'وعليكم السلام',
  'سلام عليكم',
  'سلام',
  'مرحبا',
  'اهلا',
  'اهلين',
  'هلا',
  'صباح الخير',
  'مساء الخير',
  'شكرا',
  'مشكور',
  'مشكوره',
  'يعطيك العافيه',
  'جزاك الله خير',
  'تمام',
  'طيب',
];
/** Words that may accompany a core phrase but never make one alone. */
const FILLERS = [
  'very much',
  'so much',
  'a lot',
  'again',
  'there',
  'all',
  'dear',
  'sir',
  'madam',
  'team',
  'jazeelan',
  'جزيلا',
  'ورحمه الله وبركاته',
  'ورحمه الله',
  'كثير',
  'اخي',
  'اختي',
];

const phraseRegex = (phrases: string[]) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${[...phrases]
      .sort((a, b) => b.length - a.length)
      .map((p) =>
        p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
      )
      .join('|')})(?![\\p{L}\\p{N}])`,
    'gu'
  );
const CORE_RE = phraseRegex(CORE_PHRASES);
const FILLER_RE = phraseRegex(FILLERS);
/** An emoji, with its modifiers (skin tone, variation selector, ZWJ). */
const EMOJI_RE =
  /\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]|\p{Extended_Pictographic})*/gu;
const QUESTION_RUN = /[?؟]+/g;

function normalise(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // tashkeel, tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(
      /[^\p{L}\p{N}\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]+/gu,
      ' '
    )
    .trim();
}

const wordCount = (text: string): number =>
  text.split(/\s+/).filter(Boolean).length;

/** Only greeting / thanks / acknowledgement phrases and emoji. */
export function isGreetingOrThanks(text: string): boolean {
  let core = 0;
  const rest = normalise(text)
    .replace(CORE_RE, () => {
      core++;
      return ' ';
    })
    .replace(EMOJI_RE, () => {
      core++;
      return ' ';
    })
    .replace(FILLER_RE, ' ')
    .trim();
  return core > 0 && rest === '';
}

/**
 * Tier when Jev is unavailable. Small: at most five words, all of them a
 * greeting, thanks or acknowledgement (English or Arabic) or an emoji,
 * outside a flow. Large: over sixty words, or two or more questions (a
 * run like "??" counts once — it is emphasis, not a second question).
 */
export function tierFromHeuristic(
  text: string,
  ctx: RouterContext
): TierDecision {
  const words = wordCount(text);
  const questions = text.match(QUESTION_RUN)?.length ?? 0;
  if (!ctx.inFlow && words <= SMALL_MAX_WORDS && isGreetingOrThanks(text))
    return {
      tier: 'small',
      skipKnowledge: true,
      detail: `heuristic greeting, ${words} words`,
    };
  if (words > LARGE_MIN_WORDS || questions >= 2)
    return {
      tier: 'large',
      skipKnowledge: false,
      detail: `heuristic ${words} words, ${questions} questions`,
    };
  return {
    tier: 'standard',
    skipKnowledge: false,
    detail: `heuristic ${words} words, ${questions} questions`,
  };
}

// ------------------------------------------------------------
// Model resolution
// ------------------------------------------------------------

export interface RouterModelConfig {
  model: string;
  modelSmall: string | null;
  modelLarge: string | null;
  modelRouting: boolean;
}

/**
 * The model for a tier. Routing off → `model`. A tier with no model of
 * its own falls back to `model`; the requested tier is still reported
 * (so logs say what the judgment asked for), and `model` says what
 * actually answers.
 */
export function resolveTierModel(
  config: RouterModelConfig,
  tier: RouterTier
): { tier: RouterTier; model: string } {
  if (!config.modelRouting) return { tier, model: config.model };
  if (tier === 'small')
    return { tier, model: config.modelSmall ?? config.model };
  if (tier === 'large')
    return { tier, model: config.modelLarge ?? config.model };
  return { tier, model: config.model };
}

/** One tier up, for "escalate on uncertainty"; null above `large`. */
export function nextTierUp(tier: RouterTier): RouterTier | null {
  return tier === 'small' ? 'standard' : tier === 'standard' ? 'large' : null;
}

// ------------------------------------------------------------
// Orchestration
// ------------------------------------------------------------

export interface RouteResult extends TierDecision {
  model: string;
  source: RouterSource;
}

export type RouteJudge = (input: RouteInput) => Promise<RouteJudgment>;

/** The process-wide decision layer's route judgment; layer off = unavailable. */
const jevJudge: RouteJudge = async (input) => {
  const ts = getDecisionLayer();
  return ts
    ? ts.route(input)
    : { ok: false, errorCode: 'DISABLED', latencyMs: 0 };
};

/**
 * Picks the tier and model for one inbound message. Routing off: the
 * account's model, no judgment requested. Otherwise Jev decides, and the
 * heuristic when Jev is unavailable. Never throws.
 */
export async function routeMessage(args: {
  config: RouterModelConfig;
  accountId: string;
  /** Everything the customer wrote since the bot last spoke. */
  message: string;
  recentTurns?: RouteInput['recentTurns'];
  journeyStage: string;
  ctx: RouterContext;
  /** Injected for tests; defaults to the shared decision layer. */
  judge?: RouteJudge;
}): Promise<RouteResult> {
  const { config, ctx } = args;
  if (!config.modelRouting)
    return {
      tier: 'standard',
      model: config.model,
      source: 'fixed',
      skipKnowledge: false,
      detail: 'routing off',
    };

  let judgment: RouteJudgment;
  try {
    judgment = await (args.judge ?? jevJudge)({
      accountId: args.accountId,
      message: args.message,
      recentTurns: args.recentTurns,
      journeyStage: args.journeyStage,
    });
  } catch {
    judgment = { ok: false, errorCode: 'UNKNOWN', latencyMs: 0 };
  }

  if (judgment.ok) {
    const d = tierFromJudgment(judgment, ctx);
    return { ...d, ...resolveTierModel(config, d.tier), source: 'jev' };
  }
  const d = tierFromHeuristic(args.message, ctx);
  return {
    ...d,
    ...resolveTierModel(config, d.tier),
    source: 'heuristic',
    detail: `${d.detail} (jev ${judgment.errorCode})`,
  };
}
