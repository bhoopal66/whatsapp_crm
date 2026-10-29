// ============================================================
// Smart insights settings (migration 147): the row <-> object mapping,
// the defaults and the PUT body validation.
//
// Dependency-free on purpose: the settings panel (a client component)
// and the API route share it, and a client import graph that reaches a
// server module breaks the production build.
// ============================================================

import type { AttentionRules } from './bands';

export type TagSuggestMode = 'off' | 'suggest' | 'auto';
export type ComposeCheckMode = 'off' | 'warn';

export const TAG_SUGGEST_MODES: readonly TagSuggestMode[] = [
  'off',
  'suggest',
  'auto',
];
export const COMPOSE_CHECK_MODES: readonly ComposeCheckMode[] = ['off', 'warn'];

/** Bounds of tag_auto_min_p, as 147's CHECK. */
export const TAG_AUTO_MIN_P_MIN = 0.6;
export const TAG_AUTO_MIN_P_MAX = 0.99;
export const TAG_AUTO_MIN_P_DEFAULT = 0.85;

export interface InsightSettings {
  signalsEnabled: boolean;
  tagSuggestMode: TagSuggestMode;
  tagAutoMinP: number;
  replyClassEnabled: boolean;
  replyInterestedTagId: string | null;
  composeCheckMode: ComposeCheckMode;
  meaningTriggersEnabled: boolean;
  kbGapJudgeEnabled: boolean;
  /** Pin a chat until someone acts (migration 153), per cause. */
  attentionPinUrgent: boolean;
  attentionPinUpset: boolean;
  attentionPinWantsPerson: boolean;
  attentionPinCallback: boolean;
  /** Notify the assigned person when a chat is pinned. */
  attentionNotify: boolean;
  /** The saved row's version; null when nothing was ever saved. */
  updatedAt: string | null;
}

/** No row: every feature off (147's column defaults). */
export const INSIGHT_SETTINGS_OFF: InsightSettings = Object.freeze({
  signalsEnabled: false,
  tagSuggestMode: 'off',
  tagAutoMinP: TAG_AUTO_MIN_P_DEFAULT,
  replyClassEnabled: false,
  replyInterestedTagId: null,
  composeCheckMode: 'off',
  meaningTriggersEnabled: false,
  kbGapJudgeEnabled: false,
  attentionPinUrgent: true,
  attentionPinUpset: true,
  attentionPinWantsPerson: true,
  attentionPinCallback: true,
  attentionNotify: true,
  updatedAt: null,
}) as InsightSettings;

/** The ai_insight_settings row as PostgREST returns it. */
export interface InsightSettingsRow {
  account_id: string;
  signals_enabled: boolean;
  tag_suggest_mode: string;
  tag_auto_min_p: number;
  reply_class_enabled: boolean;
  reply_interested_tag_id: string | null;
  compose_check_mode: string;
  meaning_triggers_enabled: boolean;
  kb_gap_judge_enabled: boolean;
  attention_pin_urgent: boolean;
  attention_pin_upset: boolean;
  attention_pin_wants_person: boolean;
  attention_pin_callback: boolean;
  attention_notify: boolean;
  updated_at: string;
  updated_by: string | null;
}

export const INSIGHT_SETTINGS_COLUMNS =
  'account_id, signals_enabled, tag_suggest_mode, tag_auto_min_p, reply_class_enabled, reply_interested_tag_id, compose_check_mode, meaning_triggers_enabled, kb_gap_judge_enabled, attention_pin_urgent, attention_pin_upset, attention_pin_wants_person, attention_pin_callback, attention_notify, updated_at, updated_by';

const isTagSuggestMode = (v: unknown): v is TagSuggestMode =>
  typeof v === 'string' && (TAG_SUGGEST_MODES as string[]).includes(v);
const isComposeCheckMode = (v: unknown): v is ComposeCheckMode =>
  typeof v === 'string' && (COMPOSE_CHECK_MODES as string[]).includes(v);

/** Rounds to two places: a `real` column reads back as 0.8500000238. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A row (or none) as settings. Tolerant: an unknown mode reads as off,
 * so a value a later migration adds never switches a feature on here.
 */
export function settingsFromRow(
  row: Partial<InsightSettingsRow> | null | undefined
): InsightSettings {
  if (!row) return INSIGHT_SETTINGS_OFF;
  const p = Number(row.tag_auto_min_p);
  return {
    signalsEnabled: row.signals_enabled === true,
    tagSuggestMode: isTagSuggestMode(row.tag_suggest_mode)
      ? row.tag_suggest_mode
      : 'off',
    tagAutoMinP:
      Number.isFinite(p) && p >= TAG_AUTO_MIN_P_MIN && p <= TAG_AUTO_MIN_P_MAX
        ? round2(p)
        : TAG_AUTO_MIN_P_DEFAULT,
    replyClassEnabled: row.reply_class_enabled === true,
    replyInterestedTagId:
      typeof row.reply_interested_tag_id === 'string'
        ? row.reply_interested_tag_id
        : null,
    composeCheckMode: isComposeCheckMode(row.compose_check_mode)
      ? row.compose_check_mode
      : 'off',
    meaningTriggersEnabled: row.meaning_triggers_enabled === true,
    kbGapJudgeEnabled: row.kb_gap_judge_enabled === true,
    // On unless saved off (153's default), so a short row never unpins.
    attentionPinUrgent: row.attention_pin_urgent !== false,
    attentionPinUpset: row.attention_pin_upset !== false,
    attentionPinWantsPerson: row.attention_pin_wants_person !== false,
    attentionPinCallback: row.attention_pin_callback !== false,
    attentionNotify: row.attention_notify !== false,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
  };
}

/** The editable fields, as the PUT body carries them. */
export type InsightSettingsValues = Omit<InsightSettings, 'updatedAt'>;

export interface InsightSettingsPut extends InsightSettingsValues {
  /** The version the admin was looking at; null for a first save. */
  expectedUpdatedAt: string | null;
}

/** The columns a save writes (updated_at is the trigger's). */
export function rowFromValues(
  accountId: string,
  userId: string,
  v: InsightSettingsValues
): Omit<InsightSettingsRow, 'updated_at'> {
  return {
    account_id: accountId,
    signals_enabled: v.signalsEnabled,
    tag_suggest_mode: v.tagSuggestMode,
    tag_auto_min_p: v.tagAutoMinP,
    reply_class_enabled: v.replyClassEnabled,
    reply_interested_tag_id: v.replyInterestedTagId,
    compose_check_mode: v.composeCheckMode,
    meaning_triggers_enabled: v.meaningTriggersEnabled,
    kb_gap_judge_enabled: v.kbGapJudgeEnabled,
    attention_pin_urgent: v.attentionPinUrgent,
    attention_pin_upset: v.attentionPinUpset,
    attention_pin_wants_person: v.attentionPinWantsPerson,
    attention_pin_callback: v.attentionPinCallback,
    attention_notify: v.attentionNotify,
    updated_by: userId,
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; error: string };

/** Validates a PUT body. Every field is required: the panel sends them all. */
export function parseInsightSettingsPut(
  body: unknown
): ParseResult<InsightSettingsPut> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, error: 'Expected an object' };
  const b = body as Record<string, unknown>;
  for (const key of [
    'signalsEnabled',
    'replyClassEnabled',
    'meaningTriggersEnabled',
    'kbGapJudgeEnabled',
    'attentionPinUrgent',
    'attentionPinUpset',
    'attentionPinWantsPerson',
    'attentionPinCallback',
    'attentionNotify',
  ] as const) {
    if (typeof b[key] !== 'boolean')
      return { ok: false, error: `${key} must be true or false` };
  }
  if (!isTagSuggestMode(b.tagSuggestMode))
    return { ok: false, error: 'tagSuggestMode must be off, suggest or auto' };
  if (!isComposeCheckMode(b.composeCheckMode))
    return { ok: false, error: 'composeCheckMode must be off or warn' };
  const p = b.tagAutoMinP;
  if (
    typeof p !== 'number' ||
    !Number.isFinite(p) ||
    p < TAG_AUTO_MIN_P_MIN ||
    p > TAG_AUTO_MIN_P_MAX
  )
    return {
      ok: false,
      error: `tagAutoMinP must be between ${TAG_AUTO_MIN_P_MIN} and ${TAG_AUTO_MIN_P_MAX}`,
    };
  const tag = b.replyInterestedTagId;
  if (tag !== null && (typeof tag !== 'string' || !UUID_RE.test(tag)))
    return {
      ok: false,
      error: 'replyInterestedTagId must be a tag id or null',
    };
  const expected = b.expectedUpdatedAt;
  if (expected !== null && typeof expected !== 'string')
    return { ok: false, error: 'expectedUpdatedAt must be a string or null' };
  return {
    ok: true,
    value: {
      signalsEnabled: b.signalsEnabled as boolean,
      tagSuggestMode: b.tagSuggestMode,
      tagAutoMinP: round2(p),
      replyClassEnabled: b.replyClassEnabled as boolean,
      replyInterestedTagId: tag as string | null,
      composeCheckMode: b.composeCheckMode,
      meaningTriggersEnabled: b.meaningTriggersEnabled as boolean,
      kbGapJudgeEnabled: b.kbGapJudgeEnabled as boolean,
      attentionPinUrgent: b.attentionPinUrgent as boolean,
      attentionPinUpset: b.attentionPinUpset as boolean,
      attentionPinWantsPerson: b.attentionPinWantsPerson as boolean,
      attentionPinCallback: b.attentionPinCallback as boolean,
      attentionNotify: b.attentionNotify as boolean,
      expectedUpdatedAt: expected as string | null,
    },
  };
}

/** GET /api/insights/settings */
export interface InsightSettingsResponse {
  settings: InsightSettings;
  /** Jev can run for this workspace (key + allowlist). */
  available: boolean;
  canEdit: boolean;
}

/** True when two settings differ in any editable field. */
export function settingsDiffer(
  a: InsightSettingsValues,
  b: InsightSettingsValues
): boolean {
  return (
    a.signalsEnabled !== b.signalsEnabled ||
    a.tagSuggestMode !== b.tagSuggestMode ||
    a.tagAutoMinP !== b.tagAutoMinP ||
    a.replyClassEnabled !== b.replyClassEnabled ||
    a.replyInterestedTagId !== b.replyInterestedTagId ||
    a.composeCheckMode !== b.composeCheckMode ||
    a.meaningTriggersEnabled !== b.meaningTriggersEnabled ||
    a.kbGapJudgeEnabled !== b.kbGapJudgeEnabled ||
    a.attentionPinUrgent !== b.attentionPinUrgent ||
    a.attentionPinUpset !== b.attentionPinUpset ||
    a.attentionPinWantsPerson !== b.attentionPinWantsPerson ||
    a.attentionPinCallback !== b.attentionPinCallback ||
    a.attentionNotify !== b.attentionNotify
  );
}

/** Which causes pin a chat, as the pin decision takes them. */
export function attentionRulesFrom(
  s: Pick<
    InsightSettings,
    | 'attentionPinUrgent'
    | 'attentionPinUpset'
    | 'attentionPinWantsPerson'
    | 'attentionPinCallback'
  >
): AttentionRules {
  return {
    urgent: s.attentionPinUrgent,
    upset: s.attentionPinUpset,
    wantsPerson: s.attentionPinWantsPerson,
    callback: s.attentionPinCallback,
  };
}
