/**
 * The Smart insights colour system (docs/jev-insights.md): one swatch per
 * signal value, so a lead band, a mood, an attention reason, an intent,
 * an objection or an urgency band wears the same colour on every screen
 * (inbox rows, the legend, the customer card, deals, home).
 *
 * Dependency-free on purpose — no imports at all — so client components,
 * server code and tests can all use it.
 *
 * Every class below is a complete literal. Tailwind finds classes by
 * scanning source text, so a name composed at runtime (a template that
 * splices a hue into "bg-…-50") is never generated and silently renders
 * unstyled. Each string carries
 * its own `dark:` pair: dark mode is `html[data-mode='dark']`, and a raw
 * hue needs a shade per mode (CLAUDE.md). insights/palette.test.ts holds
 * every string to that.
 */

/** The four class strings a signal value wears. */
export interface Swatch {
  /** Soft pill: background, text and an inset ring, both modes. */
  chip: string;
  /** A small solid dot. */
  dot: string;
  /** A row's left-border colour (pair with `border-s-4` or similar). */
  stripe: string;
  /** Text in the value's colour. */
  text: string;
}

// One swatch per hue, each string written out whole (see above).

const SLATE: Swatch = {
  chip: 'bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-500/20 dark:bg-slate-400/10 dark:text-slate-300 dark:ring-slate-400/25',
  dot: 'bg-slate-400 dark:bg-slate-500',
  stripe: 'border-s-slate-400 dark:border-s-slate-500',
  text: 'text-slate-600 dark:text-slate-300',
};

const ZINC: Swatch = {
  chip: 'bg-zinc-100 text-zinc-700 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-400/10 dark:text-zinc-300 dark:ring-zinc-400/25',
  dot: 'bg-zinc-400 dark:bg-zinc-500',
  stripe: 'border-s-zinc-400 dark:border-s-zinc-500',
  text: 'text-zinc-600 dark:text-zinc-300',
};

const AMBER: Swatch = {
  chip: 'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-600/25 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-400/25',
  dot: 'bg-amber-500 dark:bg-amber-400',
  stripe: 'border-s-amber-500 dark:border-s-amber-400',
  text: 'text-amber-700 dark:text-amber-300',
};

const ORANGE: Swatch = {
  chip: 'bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-600/20 dark:bg-orange-400/10 dark:text-orange-300 dark:ring-orange-400/25',
  dot: 'bg-orange-500 dark:bg-orange-400',
  stripe: 'border-s-orange-500 dark:border-s-orange-400',
  text: 'text-orange-700 dark:text-orange-300',
};

const EMERALD: Swatch = {
  chip: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/25',
  dot: 'bg-emerald-500 dark:bg-emerald-400',
  stripe: 'border-s-emerald-500 dark:border-s-emerald-400',
  text: 'text-emerald-700 dark:text-emerald-300',
};

const TEAL: Swatch = {
  chip: 'bg-teal-50 text-teal-700 ring-1 ring-inset ring-teal-600/20 dark:bg-teal-400/10 dark:text-teal-300 dark:ring-teal-400/25',
  dot: 'bg-teal-500 dark:bg-teal-400',
  stripe: 'border-s-teal-500 dark:border-s-teal-400',
  text: 'text-teal-700 dark:text-teal-300',
};

const RED: Swatch = {
  chip: 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-400/10 dark:text-red-300 dark:ring-red-400/25',
  dot: 'bg-red-500 dark:bg-red-400',
  stripe: 'border-s-red-500 dark:border-s-red-400',
  text: 'text-red-700 dark:text-red-300',
};

const ROSE: Swatch = {
  chip: 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-600/20 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-400/25',
  dot: 'bg-rose-500 dark:bg-rose-400',
  stripe: 'border-s-rose-500 dark:border-s-rose-400',
  text: 'text-rose-700 dark:text-rose-300',
};

const VIOLET: Swatch = {
  chip: 'bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-600/20 dark:bg-violet-400/10 dark:text-violet-300 dark:ring-violet-400/25',
  dot: 'bg-violet-500 dark:bg-violet-400',
  stripe: 'border-s-violet-500 dark:border-s-violet-400',
  text: 'text-violet-700 dark:text-violet-300',
};

const FUCHSIA: Swatch = {
  chip: 'bg-fuchsia-50 text-fuchsia-700 ring-1 ring-inset ring-fuchsia-600/20 dark:bg-fuchsia-400/10 dark:text-fuchsia-300 dark:ring-fuchsia-400/25',
  dot: 'bg-fuchsia-500 dark:bg-fuchsia-400',
  stripe: 'border-s-fuchsia-500 dark:border-s-fuchsia-400',
  text: 'text-fuchsia-700 dark:text-fuchsia-300',
};

const PURPLE: Swatch = {
  chip: 'bg-purple-50 text-purple-700 ring-1 ring-inset ring-purple-600/20 dark:bg-purple-400/10 dark:text-purple-300 dark:ring-purple-400/25',
  dot: 'bg-purple-500 dark:bg-purple-400',
  stripe: 'border-s-purple-500 dark:border-s-purple-400',
  text: 'text-purple-700 dark:text-purple-300',
};

const SKY: Swatch = {
  chip: 'bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-600/20 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-400/25',
  dot: 'bg-sky-500 dark:bg-sky-400',
  stripe: 'border-s-sky-500 dark:border-s-sky-400',
  text: 'text-sky-700 dark:text-sky-300',
};

const BLUE: Swatch = {
  chip: 'bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-600/20 dark:bg-blue-400/10 dark:text-blue-300 dark:ring-blue-400/25',
  dot: 'bg-blue-500 dark:bg-blue-400',
  stripe: 'border-s-blue-500 dark:border-s-blue-400',
  text: 'text-blue-700 dark:text-blue-300',
};

const INDIGO: Swatch = {
  chip: 'bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-600/20 dark:bg-indigo-400/10 dark:text-indigo-300 dark:ring-indigo-400/25',
  dot: 'bg-indigo-500 dark:bg-indigo-400',
  stripe: 'border-s-indigo-500 dark:border-s-indigo-400',
  text: 'text-indigo-700 dark:text-indigo-300',
};

const CYAN: Swatch = {
  chip: 'bg-cyan-50 text-cyan-800 ring-1 ring-inset ring-cyan-600/25 dark:bg-cyan-400/10 dark:text-cyan-300 dark:ring-cyan-400/25',
  dot: 'bg-cyan-500 dark:bg-cyan-400',
  stripe: 'border-s-cyan-500 dark:border-s-cyan-400',
  text: 'text-cyan-700 dark:text-cyan-300',
};

// ---------------------------------------------------------------------------
// Families, keys in display order
// ---------------------------------------------------------------------------

/** The families, in the order the legend shows them. */
export const PALETTE_FAMILIES = [
  'attention',
  'sentiment',
  'lead',
  'urgency',
  'intent',
  'objection',
] as const;

export type PaletteFamily = (typeof PALETTE_FAMILIES)[number];

/**
 * Each family's keys, in display order. `lead` and `urgency` restate
 * `LeadBand` / `UrgencyBand`, `intent` restates `INSIGHT_INTENT_KEYS`
 * and `sentiment` restates `SentimentBand` (all lib/insights/bands.ts);
 * `attention` is migration 153's `insight_attention_reason` plus the AI
 * hand-off (`ai_attention_at`), most severe first; `objection` is 153's
 * `insight_objections` vocabulary. palette.test.ts keeps them equal.
 */
export const PALETTE_KEYS = {
  attention: ['urgent', 'ai_handoff', 'wants_person', 'upset', 'callback'],
  sentiment: [
    'very_negative',
    'negative',
    'neutral',
    'positive',
    'very_positive',
  ],
  lead: ['cold', 'warm', 'hot', 'ready'],
  urgency: ['urgent', 'soon', 'none'],
  intent: [
    'account_opening',
    'pos_terminal',
    'business_loan',
    'trade_working_capital',
    'application_status',
    'other_banking',
    'complaint',
    'smalltalk',
    'unclear',
    'other_request',
  ],
  objection: [
    'price',
    'documents',
    'eligibility',
    'trust',
    'timing',
    'comparing',
  ],
} as const;

export type PaletteKey<F extends PaletteFamily> =
  (typeof PALETTE_KEYS)[F][number];

export type AttentionKey = PaletteKey<'attention'>;
export type SentimentKey = PaletteKey<'sentiment'>;
export type ObjectionKey = PaletteKey<'objection'>;

/** One family-and-key pair, discriminated on `family`. */
export type PaletteRef = {
  [F in PaletteFamily]: { family: F; key: PaletteKey<F> };
}[PaletteFamily];

export const INSIGHT_PALETTE: {
  readonly [F in PaletteFamily]: Readonly<Record<PaletteKey<F>, Swatch>>;
} = {
  attention: {
    urgent: RED,
    ai_handoff: ROSE,
    wants_person: VIOLET,
    upset: FUCHSIA,
    callback: SKY,
  },
  sentiment: {
    very_negative: RED,
    negative: ORANGE,
    neutral: SLATE,
    positive: TEAL,
    very_positive: EMERALD,
  },
  lead: {
    cold: SLATE,
    warm: AMBER,
    hot: ORANGE,
    ready: EMERALD,
  },
  urgency: {
    urgent: RED,
    soon: AMBER,
    none: ZINC,
  },
  intent: {
    account_opening: SKY,
    pos_terminal: INDIGO,
    business_loan: EMERALD,
    trade_working_capital: CYAN,
    application_status: SLATE,
    other_banking: BLUE,
    complaint: ROSE,
    smalltalk: ZINC,
    unclear: ZINC,
    other_request: ZINC,
  },
  objection: {
    price: AMBER,
    documents: BLUE,
    eligibility: PURPLE,
    trust: ROSE,
    timing: SLATE,
    comparing: CYAN,
  },
};

/** The swatch of one family's key. */
export function paletteFor<F extends PaletteFamily>(
  family: F,
  key: PaletteKey<F>
): Swatch {
  return (INSIGHT_PALETTE[family] as Readonly<Record<string, Swatch>>)[key];
}

/** The swatch of a {@link PaletteRef} (as `rowSignals` returns them). */
export function swatchOf(ref: PaletteRef): Swatch {
  return (INSIGHT_PALETTE[ref.family] as Readonly<Record<string, Swatch>>)[
    ref.key
  ];
}

/** Whether `key` is one of `family`'s keys (for values read from the DB). */
export function isPaletteKey<F extends PaletteFamily>(
  family: F,
  key: unknown
): key is PaletteKey<F> {
  return (
    typeof key === 'string' &&
    (PALETTE_KEYS[family] as readonly string[]).includes(key)
  );
}
