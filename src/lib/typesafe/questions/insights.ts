/**
 * Smart insights (docs/jev-insights.md): one request per inbound customer
 * turn that reads the customer's signals and suggests one of the
 * workspace's own chat tags. Not a safety check — no account switch,
 * policy or ts_decision_log row.
 *
 * The signal questions are the triage question objects themselves, not
 * copies: an urgency of 1.6 means the same thing whether the bot's
 * triage or this request produced it, so the two can be stored side by
 * side. A change to their wording is a triage change (QS_VERSION).
 *
 * The tag questions are built per workspace from its catalogue. Tag ids
 * are UUIDs, and the gateway's PII guard refuses a request carrying one,
 * so options are ordinals (`t1`, `s1`) mapped back through `keyMap`.
 *
 * Wording is literal by design (jev reads instructions at face value).
 * Changing any wording here means a new INSIGHTS_QS_VERSION.
 */
import { choice, type ChoiceQuestion } from '@typesafe-ai/sdk';
import { redactClipped } from '../checks/common';
import { TRIAGE_QUESTIONS } from './triage';

export const INSIGHTS_QS_VERSION = 'qs-insights-v1';

export const SIGNAL_QUESTIONS = {
  intent: TRIAGE_QUESTIONS.intent,
  urgency: TRIAGE_QUESTIONS.urgency,
  lead_temperature: TRIAGE_QUESTIONS.lead_temperature,
  dissatisfied: TRIAGE_QUESTIONS.dissatisfied,
  wants_human: TRIAGE_QUESTIONS.wants_human,
} as const;

/** The fields SIGNAL_QUESTIONS and the tag questions refer to. None of the
 *  reused triage questions reads `partner_banks`, so it is not sent. */
export interface InsightsState {
  message: string;
  recent_turns: { from: 'customer' | 'taamul'; text: string }[];
  journey_stage: string;
  // index signature so the object satisfies the SDK's JSON state type
  [key: string]: unknown;
}

export interface TagCatalogueSub {
  id: string;
  name: string;
  hint: string | null;
}

export interface TagCatalogueMain {
  id: string;
  name: string;
  hint: string | null;
  /** The main tag's caption for its sub-tags ("Bank"), if any. */
  subTitle: string | null;
  subs: TagCatalogueSub[];
}

/** A workspace's chat tags, main tags in display order. */
export interface TagCatalogue {
  mains: TagCatalogueMain[];
}

/** Main tags offered in `chat_tag`; the rest of the catalogue is ignored. */
export const MAX_SUGGEST_MAIN_TAGS = 15;
/** Sub-tags offered per sub-tag question. */
export const MAX_SUGGEST_SUB_TAGS = 12;
/** Sub-tag questions per request: the first main tags that have sub-tags. */
export const MAX_SUB_TAG_QUESTIONS = 8;
export const MAX_TAG_NAME_CHARS = 60;
export const MAX_TAG_HINT_CHARS = 200;
/** Shorter than a main tag's: up to 96 sub-tag hints share the request
 *  with the conversation, and the worst case must stay well inside
 *  MAX_REQUEST_CHARS (insights.test.ts measures it). */
export const MAX_SUB_TAG_HINT_CHARS = 120;

export const TAG_QUESTION_KEY = 'chat_tag';
export const NONE_OPTION = 'none';

export interface TagKeyMap {
  /** `chat_tag` option (`t1`…) → main tag id. */
  mains: Record<string, string>;
  /** Main option (`t3`) → its sub-tag question key (`sub_t3`) and that
   *  question's options (`s1`…) → sub-tag id. Only mains that got a
   *  question are present. */
  subs: Record<string, { question: string; options: Record<string, string> }>;
}

const blank = (s: string | null | undefined): boolean =>
  s == null || /^\s*$/.test(s);

// Tag names and hints are admin text, not customer text, but they still
// go through redaction: a phone number in a hint would otherwise trip the
// gateway's PII guard and withhold every insights request of the
// workspace.
const cleanName = (s: string) => redactClipped(s.trim(), MAX_TAG_NAME_CHARS);

function describe(name: string, hint: string | null, maxHint: number): string {
  const n = cleanName(name);
  return blank(hint) ? n : `${n} — ${redactClipped(hint!.trim(), maxHint)}`;
}

/**
 * The tag questions for one workspace: `chat_tag` over its main tags plus
 * `none`, and for each of the first main tags with sub-tags a speculative
 * `sub_t<k>` that states its premise ("assume it belongs under …"), so one
 * request answers both levels. The caller reads only the sub-tag question
 * of the main tag that was chosen.
 */
export function buildTagQuestions(catalogue: TagCatalogue): {
  questions: Record<string, ChoiceQuestion>;
  keyMap: TagKeyMap;
} {
  const mains = catalogue.mains.slice(0, MAX_SUGGEST_MAIN_TAGS);
  const keyMap: TagKeyMap = { mains: {}, subs: {} };
  const mainCriteria: Record<string, string> = {};
  const subQuestions: Record<string, ChoiceQuestion> = {};

  mains.forEach((m, i) => {
    const key = `t${i + 1}`;
    keyMap.mains[key] = m.id;
    mainCriteria[key] = describe(m.name, m.hint, MAX_TAG_HINT_CHARS);

    const subs = m.subs.slice(0, MAX_SUGGEST_SUB_TAGS);
    if (
      subs.length === 0 ||
      Object.keys(keyMap.subs).length >= MAX_SUB_TAG_QUESTIONS
    )
      return;
    const question = `sub_${key}`;
    const options: Record<string, string> = {};
    const criteria: Record<string, string> = {};
    subs.forEach((s, j) => {
      const sk = `s${j + 1}`;
      options[sk] = s.id;
      criteria[sk] = describe(s.name, s.hint, MAX_SUB_TAG_HINT_CHARS);
    });
    criteria[NONE_OPTION] = 'None of these fits the conversation yet.';
    const what = blank(m.subTitle) ? 'sub-tag' : cleanName(m.subTitle!);
    keyMap.subs[key] = { question, options };
    subQuestions[question] = choice(
      `Assume the conversation belongs under the chat tag "${cleanName(m.name)}". Which ${what} fits it best? Judge mainly from \`message\` and the latest \`recent_turns\`.`,
      criteria
    );
  });

  mainCriteria[NONE_OPTION] =
    'None of these tags describes the conversation yet.';
  return {
    questions: {
      [TAG_QUESTION_KEY]: choice(
        'Which chat tag best describes this conversation? Judge mainly from `message` and the latest `recent_turns`.',
        mainCriteria
      ),
      ...subQuestions,
    },
    keyMap,
  };
}
