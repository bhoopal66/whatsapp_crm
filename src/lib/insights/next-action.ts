import {
  CALLBACK_MIN_P,
  NEEDS_REPLY_MIN_P,
  OBJECTION_CODES,
  isUpset,
  leadBand,
  sentimentBand,
  wantsPerson,
  type ObjectionCode,
} from './bands';
import type { PaletteRef } from './palette';

/**
 * Smart insights "next best action" (docs/jev-insights.md): what the
 * insights card suggests the agent does next, from the conversation's
 * `insight_*` figures for the customer's latest message.
 *
 * Dependency-free (bands.ts, and palette.ts for a type) because client
 * components import it. Every threshold is a named one from bands.ts;
 * this file adds no new numbers, so it inherits their UNCALIBRATED
 * status and nothing else.
 */

type Figure = number | null | undefined;

/** The conversation columns the suggestion reads. */
export interface NextActionFigures {
  insight_at?: string | null;
  insight_lead_temp?: Figure;
  insight_upset?: Figure;
  insight_wants_human?: Figure;
  insight_sentiment?: Figure;
  insight_objections?: readonly string[] | null;
  insight_needs_reply?: Figure;
  insight_callback?: Figure;
  insight_attention_reason?: string | null;
  unread_count?: Figure;
}

/** The select list for those columns. */
export const NEXT_ACTION_COLUMNS =
  'insight_at, insight_lead_temp, insight_upset, insight_wants_human, insight_sentiment, insight_objections, insight_needs_reply, insight_callback, insight_attention_reason, unread_count';

/**
 * Every action, in tie-break order: when more apply than are shown, the
 * earlier ones win. A request the customer made in words (a call, a
 * person) comes before their mood, their mood before the open question,
 * and the open question before selling.
 */
export const NEXT_ACTION_CODES = [
  'call_back',
  'take_over',
  'calm_down',
  'reply_now',
  'send_documents',
  'address_price',
  'reassure_eligibility',
  'build_trust',
  'schedule_follow_up',
  'compare_offers',
  'move_forward',
] as const;

export type NextActionCode = (typeof NEXT_ACTION_CODES)[number];

/** Why an action was suggested; the card lists them under it. */
export const NEXT_ACTION_REASONS = [
  'asked_for_call',
  'asked_for_person',
  'pinned_for_person',
  'upset',
  'very_negative',
  'needs_reply',
  'waiting',
  'ready_to_apply',
  'objection_price',
  'objection_documents',
  'objection_eligibility',
  'objection_trust',
  'objection_timing',
  'objection_comparing',
  'hot_lead',
] as const;

export type ReasonCode = (typeof NEXT_ACTION_REASONS)[number];

export interface NextAction {
  code: NextActionCode;
  /** At least one reason, in {@link NEXT_ACTION_REASONS} order. */
  because: ReasonCode[];
  tone: PaletteRef;
}

/** At most this many actions are suggested. */
export const MAX_NEXT_ACTIONS = 2;

const known = (x: Figure): x is number =>
  typeof x === 'number' && Number.isFinite(x);

/** The objection-only actions, keyed by the objection that raises them.
 *  `documents` is absent: it joins "ready to apply" in send_documents. */
const OBJECTION_ACTIONS: Partial<Record<ObjectionCode, NextActionCode>> = {
  price: 'address_price',
  eligibility: 'reassure_eligibility',
  trust: 'build_trust',
  timing: 'schedule_follow_up',
  comparing: 'compare_offers',
};

/**
 * Up to {@link MAX_NEXT_ACTIONS} suggestions, most important first, or
 * none for a chat never judged (`insight_at` null). A null, missing or
 * NaN figure counts as absent. `insight_objections` is already
 * thresholded where it is written; unknown codes are ignored.
 */
export function nextBestActions(
  f: NextActionFigures | null | undefined
): NextAction[] {
  if (!f?.insight_at) return [];

  const found = new Map<NextActionCode, NextAction>();
  const add = (code: NextActionCode, because: ReasonCode[], tone: PaletteRef) =>
    found.set(code, { code, because, tone });

  if (known(f.insight_callback) && f.insight_callback >= CALLBACK_MIN_P)
    add('call_back', ['asked_for_call'], {
      family: 'attention',
      key: 'callback',
    });

  const takeOver: ReasonCode[] = [];
  if (wantsPerson(f.insight_wants_human)) takeOver.push('asked_for_person');
  if (f.insight_attention_reason === 'wants_person')
    takeOver.push('pinned_for_person');
  if (takeOver.length)
    add('take_over', takeOver, { family: 'attention', key: 'wants_person' });

  const upset = isUpset(f.insight_upset);
  const veryNegative = sentimentBand(f.insight_sentiment) === 'very_negative';
  if (upset || veryNegative)
    add(
      'calm_down',
      [
        ...(upset ? ['upset' as const] : []),
        ...(veryNegative ? ['very_negative' as const] : []),
      ],
      upset
        ? { family: 'attention', key: 'upset' }
        : { family: 'sentiment', key: 'very_negative' }
    );

  if (
    known(f.insight_needs_reply) &&
    f.insight_needs_reply >= NEEDS_REPLY_MIN_P &&
    known(f.unread_count) &&
    f.unread_count > 0
  )
    add('reply_now', ['needs_reply', 'waiting'], {
      family: 'urgency',
      key: 'soon',
    });

  const objections = new Set(
    (f.insight_objections ?? []).filter((c): c is ObjectionCode =>
      (OBJECTION_CODES as readonly string[]).includes(c)
    )
  );
  const lead = leadBand(f.insight_lead_temp);

  const docs: ReasonCode[] = [];
  if (lead === 'ready') docs.push('ready_to_apply');
  if (objections.has('documents')) docs.push('objection_documents');
  if (docs.length)
    add(
      'send_documents',
      docs,
      lead === 'ready'
        ? { family: 'lead', key: 'ready' }
        : { family: 'objection', key: 'documents' }
    );

  for (const code of OBJECTION_CODES) {
    const action = OBJECTION_ACTIONS[code];
    if (action && objections.has(code))
      add(action, [`objection_${code}`], { family: 'objection', key: code });
  }

  // "Hot", not "ready": a ready customer already gets send_documents.
  if (lead === 'hot' && objections.size === 0)
    add('move_forward', ['hot_lead'], { family: 'lead', key: 'hot' });

  return NEXT_ACTION_CODES.flatMap((c) => found.get(c) ?? []).slice(
    0,
    MAX_NEXT_ACTIONS
  );
}
