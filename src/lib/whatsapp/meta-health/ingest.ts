/**
 * Meta WhatsApp Business Account webhook body → number / template / account
 * health events, and the arguments for migration 188's writers
 * (`meta_health_event_record`, `meta_template_health_set`,
 * `meta_number_state_set`). WATCH-ONLY: nothing here blocks a send.
 *
 * Ported from wacrm module 017b (`src/protect/ingest.ts`). Total: never
 * throws; a change it cannot use is reported in `errors`. Fields it does not
 * handle (`messages`, `group_*`, anything else) are skipped silently: other
 * code owns them.
 *
 * Server-only (node:crypto). Never import this from a 'use client' file.
 *
 * VERIFY AGAINST META'S DOCS BEFORE PRODUCTION: the `field` names and `value`
 * keys read below are from prior knowledge of Meta's webhook reference;
 * developers.facebook.com was unreachable when the package was written
 * (2026-10-05) and none of them has been re-checked.
 */
import { createHash } from 'node:crypto';

import type { NumberHealthState } from './state';
import {
  ASSESSED_STATES,
  boundedText,
  normalizeQuality,
  type AssessedState,
  type QualityRating,
} from './values';

export {
  ASSESSED_STATES,
  QUALITY_RATINGS,
  boundedText,
  normalizeQuality,
  type AssessedState,
  type QualityRating,
} from './values';

/** The webhook `field`s handled; stored verbatim as `meta_health_events.kind`. */
export const META_HEALTH_KINDS = [
  'account_update',
  'account_review_update',
  'phone_number_quality_update',
  'message_template_quality_update',
  'message_template_status_update',
] as const;
export type MetaHealthKind = (typeof META_HEALTH_KINDS)[number];

export type AccountRestriction = { type: string; expiresAt?: string };

/** One parsed change. Only defined values are present (no `undefined` keys). */
export type HealthEvent = {
  /** The webhook `field`, verbatim (= `p_kind`). */
  kind: MetaHealthKind;
  /** WhatsApp Business Account id (`entry[].id`), when present. */
  wabaId?: string;
  /** `entry[].time` as ISO-8601; receipt time when Meta sent none. */
  at: string;
  /** Meta's `event` (or `decision` for account_review_update), verbatim. */
  event?: string;
  // phone_number_quality_update (and account_update's phone_number)
  displayPhoneNumber?: string;
  /** Messaging-limit tier, e.g. "TIER_1K". */
  currentLimit?: string;
  // message_template_*
  templateId?: string;
  templateName?: string;
  templateLanguage?: string;
  /** Template status: Meta's rejection/pause reason. */
  reason?: string;
  /** Template quality: GREEN | YELLOW | RED | UNKNOWN, verbatim. */
  newQuality?: string;
  previousQuality?: string;
  // account_update
  restrictions?: AccountRestriction[];
  violationType?: string;
  banState?: string;
};

export type IngestedEvent = { event: HealthEvent; dedupKey: string };
export type IngestResult = { events: IngestedEvent[]; errors: string[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;
/** Meta sends some ids (message_template_id) as JSON numbers. */
const id = (v: unknown): string | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? String(v) : str(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});

type Base = { kind: MetaHealthKind; at: string; wabaId?: string };
type Reader = (v: Obj, base: Base, out: IngestResult, key: string) => void;

// Field names: VERIFY AGAINST META'S DOCS BEFORE PRODUCTION (file header).
const READERS: Record<MetaHealthKind, Reader> = {
  phone_number_quality_update: readNumberQuality,
  message_template_status_update: readTemplateStatus,
  message_template_quality_update: readTemplateQuality,
  account_update: readAccount,
  account_review_update: readAccount,
};

const isHandled = (field: string): field is MetaHealthKind =>
  Object.hasOwn(READERS, field);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
/** Sorted keys, `undefined` dropped; never throws on JSON-parsed input. */
function canonical(v: unknown): Json {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const o: { [k: string]: Json } = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Obj)[k];
      if (x !== undefined) o[k] = canonical(x);
    }
    return o;
  }
  return v as Json;
}

/**
 * `p_dedup_key`: sha256 hex of the canonical JSON (sorted keys) of one
 * entry's change — field, value, entry id and entry time, as Meta sent them.
 * A redelivery hashes the same whatever the key order; a missing entry time
 * stays missing, so it does not turn into a fresh receipt time.
 */
export function metaHealthDedupKey(change: {
  field: unknown;
  value: unknown;
  entryId: unknown;
  entryTime: unknown;
}): string {
  const doc = canonical({
    entry_id: change.entryId,
    entry_time: change.entryTime,
    field: change.field,
    value: change.value,
  });
  return createHash('sha256').update(JSON.stringify(doc)).digest('hex');
}

export function ingestMetaHealth(
  payload: unknown,
  now: () => Date = () => new Date()
): IngestResult {
  const out: IngestResult = { events: [], errors: [] };
  try {
    if (!isObj(payload) || !Array.isArray(payload.entry)) {
      out.errors.push(
        'MALFORMED: body is not a webhook payload (missing entry[])'
      );
      return out;
    }
    for (const entry of payload.entry) {
      isolate(out, () => {
        const e = obj(entry);
        const wabaId = id(e.id);
        // Read once, and only for a change of ours: a messages-only
        // delivery never reports an entry time it does not use.
        let at: string | undefined;
        const time = () => (at ??= entryTime(e.time, out, now));
        for (const change of arr(e.changes)) {
          isolate(out, () => readChange(change, e, wabaId, time, out));
        }
      });
    }
  } catch (err) {
    out.errors.push(`MALFORMED: ingest failed: ${String(err)}`);
  }
  return out;
}

/** One bad entry or change costs one error entry, never the rest of the batch. */
function isolate(out: IngestResult, f: () => void): void {
  try {
    f();
  } catch (err) {
    out.errors.push(`MALFORMED: item skipped: ${String(err)}`);
  }
}

function readChange(
  change: unknown,
  entry: Obj,
  wabaId: string | undefined,
  time: () => string,
  out: IngestResult
): void {
  const c = obj(change);
  const field = str(c.field);
  if (!field) {
    out.errors.push('MALFORMED: change without field skipped');
    return;
  }
  // messages, group_* and every other field belong to other code.
  if (!isHandled(field)) return;
  if (!isObj(c.value)) {
    out.errors.push(`MALFORMED: ${field} without value object skipped`);
    return;
  }
  const key = metaHealthDedupKey({
    field,
    value: c.value,
    entryId: entry.id,
    entryTime: entry.time,
  });
  const base: Base = { kind: field, at: time() };
  if (wabaId) base.wabaId = wabaId;
  READERS[field](c.value, base, out, key);
}

const TS_MIN_MS = Date.UTC(2000, 0, 1);
const TS_MAX_MS = Date.UTC(2100, 0, 1);

/** Unix seconds → ISO. Absent → receipt time silently; invalid → receipt time plus an error. */
function entryTime(ts: unknown, out: IngestResult, now: () => Date): string {
  if (ts === undefined || ts === null) return now().toISOString();
  const iso = secondsToIso(ts);
  if (iso) return iso;
  out.errors.push('MALFORMED: invalid entry time, using receipt time');
  return now().toISOString();
}

function secondsToIso(ts: unknown): string | undefined {
  const ms =
    (typeof ts === 'string' || typeof ts === 'number' ? Number(ts) : NaN) *
    1000;
  return ms >= TS_MIN_MS && ms < TS_MAX_MS
    ? new Date(ms).toISOString()
    : undefined;
}

/** Copies only the defined values, so events carry no `undefined` keys. */
function emit(
  out: IngestResult,
  key: string,
  ev: HealthEvent,
  extra: Partial<Record<keyof HealthEvent, unknown>>
): void {
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) (ev as Obj)[k] = v;
  }
  out.events.push({ event: ev, dedupKey: key });
}

/** value: { display_phone_number, event, current_limit } — VERIFY AGAINST META'S DOCS. */
function readNumberQuality(
  v: Obj,
  base: Base,
  out: IngestResult,
  key: string
): void {
  const event = str(v.event);
  const currentLimit = str(v.current_limit);
  if (!event && !currentLimit) {
    out.errors.push(
      `MALFORMED: ${base.kind} without event or current_limit skipped`
    );
    return;
  }
  emit(
    out,
    key,
    { ...base },
    {
      event,
      currentLimit,
      displayPhoneNumber: str(v.display_phone_number),
    }
  );
}

/** value: { event, message_template_id, message_template_name, message_template_language, reason } — VERIFY. */
function readTemplateStatus(
  v: Obj,
  base: Base,
  out: IngestResult,
  key: string
): void {
  const event = str(v.event);
  const t = template(v);
  if (!event || (!t.templateId && !t.templateName)) {
    out.errors.push(
      `MALFORMED: ${base.kind} without event or template id/name skipped`
    );
    return;
  }
  // Meta sends reason "NONE" on approvals; kept verbatim.
  emit(out, key, { ...base }, { event, ...t, reason: str(v.reason) });
}

/** value: { new_quality_score, previous_quality_score, message_template_id, message_template_name, message_template_language } — VERIFY. */
function readTemplateQuality(
  v: Obj,
  base: Base,
  out: IngestResult,
  key: string
): void {
  const newQuality = str(v.new_quality_score);
  const t = template(v);
  if (!newQuality || (!t.templateId && !t.templateName)) {
    out.errors.push(
      `MALFORMED: ${base.kind} without new_quality_score or template id/name skipped`
    );
    return;
  }
  emit(
    out,
    key,
    { ...base },
    {
      newQuality,
      previousQuality: str(v.previous_quality_score),
      ...t,
    }
  );
}

function template(v: Obj) {
  return {
    templateId: id(v.message_template_id),
    templateName: str(v.message_template_name),
    templateLanguage: str(v.message_template_language),
  };
}

/**
 * account_update value: { event, phone_number?, restriction_info?: [{
 * restriction_type, expiration }], violation_info?: { violation_type },
 * ban_info?: { waba_ban_state } }; account_review_update value: { decision }.
 * VERIFY AGAINST META'S DOCS BEFORE PRODUCTION. Every account event is kept
 * (not only restrictions): the store is the audit trail.
 */
function readAccount(v: Obj, base: Base, out: IngestResult, key: string): void {
  const event = str(v.event) ?? str(v.decision);
  if (!event) {
    out.errors.push(`MALFORMED: ${base.kind} without event/decision skipped`);
    return;
  }
  const restrictions: AccountRestriction[] = [];
  for (const r of arr(v.restriction_info)) {
    const type = str(obj(r).restriction_type);
    if (!type) {
      out.errors.push(
        `MALFORMED: ${base.kind} restriction without restriction_type ignored`
      );
      continue;
    }
    const expiresAt = secondsToIso(obj(r).expiration);
    restrictions.push(expiresAt ? { type, expiresAt } : { type });
  }
  emit(
    out,
    key,
    { ...base },
    {
      event,
      displayPhoneNumber: str(v.phone_number),
      restrictions: restrictions.length ? restrictions : undefined,
      violationType: str(obj(v.violation_info).violation_type),
      banState: str(obj(v.ban_info).waba_ban_state),
    }
  );
}

// ---------------------------------------------------------------------------
// Arguments for 188's writers. Every value is normalised to what the CHECKs
// accept, or null.

export type HealthEventRecordArgs = {
  p_account: string;
  p_config: string;
  p_kind: MetaHealthKind;
  p_dedup_key: string;
  p_payload: HealthEvent;
};

/** `meta_health_event_record(...)`; the RPC returns false for a repeat. */
export function healthEventRecordArgs(
  accountId: string,
  configId: string,
  ingested: IngestedEvent
): HealthEventRecordArgs {
  return {
    p_account: accountId,
    p_config: configId,
    p_kind: ingested.event.kind,
    p_dedup_key: ingested.dedupKey,
    p_payload: ingested.event,
  };
}

export type TemplateHealthSetArgs = {
  p_account: string;
  p_template_name: string;
  p_language: string;
  p_quality: QualityRating | null;
  p_status: string | null;
  p_paused_until: string | null;
  p_at: string;
};

/**
 * `meta_template_health_set(...)` for a template event, or null when the
 * event is not a template event or lacks what the row needs (a name, a
 * language, and a quality or a status). `p_paused_until` is always null:
 * the package reads no pause duration from Meta.
 */
export function templateHealthSetArgs(
  accountId: string,
  ev: HealthEvent
): TemplateHealthSetArgs | null {
  if (
    ev.kind !== 'message_template_status_update' &&
    ev.kind !== 'message_template_quality_update'
  ) {
    return null;
  }
  const name = boundedText(ev.templateName, 512);
  const language = boundedText(ev.templateLanguage, 32);
  if (!name || !language) return null;
  const quality =
    ev.kind === 'message_template_quality_update'
      ? normalizeQuality(ev.newQuality)
      : null;
  const status =
    ev.kind === 'message_template_status_update'
      ? boundedText(ev.event, 64)
      : null;
  if (quality === null && status === null) return null;
  return {
    p_account: accountId,
    p_template_name: name,
    p_language: language,
    p_quality: quality,
    p_status: status,
    p_paused_until: null,
    p_at: ev.at,
  };
}

export type NumberStateSetArgs = {
  p_config: string;
  p_expected_updated_at: string | null;
  p_quality_rating: QualityRating | null;
  p_messaging_limit_tier: string | null;
  p_account_status: string | null;
  p_assessed_state: AssessedState;
  p_reasons: string[];
};

/**
 * `meta_number_state_set(...)`: compare-and-set on the `updated_at` read
 * (null when no row was read). The RPC answers null when another writer got
 * there first; re-read and retry.
 */
export function numberStateSetArgs(
  configId: string,
  expectedUpdatedAt: string | null,
  state: NumberHealthState
): NumberStateSetArgs {
  const assessed = (ASSESSED_STATES as readonly string[]).includes(
    state.assessedState
  )
    ? state.assessedState
    : 'NORMAL';
  return {
    p_config: configId,
    p_expected_updated_at: expectedUpdatedAt,
    p_quality_rating: normalizeQuality(state.qualityRating),
    p_messaging_limit_tier: boundedText(state.messagingLimitTier, 64),
    p_account_status: boundedText(state.accountStatus, 64),
    p_assessed_state: assessed,
    p_reasons: state.reasons.filter((r) => typeof r === 'string'),
  };
}
