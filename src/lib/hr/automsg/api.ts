/**
 * Typed browser wrappers over migration 203's HR automated-message RPCs.
 * Same contract as `lib/hr/api.ts`: the browser calls them with the user's
 * session, every RPC is SECURITY DEFINER and re-checks the caller, and
 * nothing throws: a refusal comes back as `{ error }` with the RPC's HINT
 * code. Rows are mapped to camelCase defensively (missing or unknown
 * fields fall back to a default, never throw).
 *
 * Client components import this file: only types and constants from the
 * sibling modules and `@/lib/hr/*`, nothing server-side.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { hrErrorCode, type HrResult } from '@/lib/hr/api';

import {
  APPROVAL_STATUSES,
  AUTO_LANGS,
  DEFAULT_SETTINGS,
  DEFAULT_TRIGGER_TEMPLATE,
  ALL_HOLD_REASONS,
  OUTBOX_STATUSES,
  TEMPLATE_CATEGORIES,
  TEMPLATE_KINDS,
  TRIGGERS,
  type ApprovalStatus,
  type AutoLang,
  type HoldReason,
  type OutboxStatus,
  type TemplateCategory,
  type TemplateKind,
  type Trigger,
} from './types';
import { channelOf, type AutomsgChannel } from './channel';

export type ConsentSource = 'recruiter_confirmed' | 'candidate_wrote' | 'form';

export interface AutoMsgSettingsView {
  killSwitch: boolean;
  quietStart: string;
  quietEnd: string;
  tz: string;
  requiresConsent: boolean;
  dailyCap: number;
  updatedAt: string | null;
}

export interface AutoMsgTriggerView {
  trigger: Trigger;
  enabled: boolean;
  templateKind: TemplateKind;
  channel: AutomsgChannel;
}

export interface AutoMsgTemplateView {
  kind: TemplateKind;
  language: AutoLang;
  channel: AutomsgChannel;
  /** For rcs: the RCS provider's template id. */
  body: string;
  metaTemplateName: string;
  approvalStatus: ApprovalStatus;
  category: TemplateCategory;
  updatedAt: string | null;
}

export interface AutoMsgConfig {
  settings: AutoMsgSettingsView;
  triggers: AutoMsgTriggerView[];
  templates: AutoMsgTemplateView[];
  role: 'admin' | 'lead';
}

export interface AutoMsgConsentView {
  /** null = no record. */
  granted: boolean | null;
  source: ConsentSource | null;
  notedAt: string | null;
  optedOut: boolean;
  personal: boolean;
}

export interface AutoMsgOutboxRow {
  id: string;
  conversationId: string;
  contactId: string;
  contactName: string | null;
  trigger: Trigger;
  templateKind: TemplateKind;
  language: AutoLang;
  status: OutboxStatus;
  holdReason: HoldReason | null;
  attempts: number;
  claimState: 'sending' | 'unconfirmed' | 'needs_review' | null;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  channel: AutomsgChannel;
}

export interface AutoMsgSettingsPatch {
  killSwitch?: boolean;
  quietStart?: string;
  quietEnd?: string;
  tz?: string;
  requiresConsent?: boolean;
  dailyCap?: number;
}

export interface AutoMsgTemplateInput {
  kind: TemplateKind;
  language: AutoLang;
  body: string;
  metaTemplateName: string;
  approvalStatus: ApprovalStatus;
  category: TemplateCategory;
  /** Left out = 'whatsapp'. */
  channel?: AutomsgChannel;
  /** The stored row's `updatedAt` the editor was filled from, or null. */
  expectedUpdatedAt: string | null;
}

export interface AutoMsgRcsStatus {
  /** An RCS provider is configured: RCS messages can be sent. */
  connected: boolean;
  /** RCS delivery receipts are configured. */
  webhook: boolean;
}

/** `GET /api/hr/automsg/sms`: the same two flags for the SMS gateway. */
export type AutoMsgSmsStatus = AutoMsgRcsStatus;

export interface AutoMsgReleaseSummary {
  reviewed: number;
  expired: number;
  outcomes: Record<string, number>;
}

// ---- defensive readers ----------------------------------------------------

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
}
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function oneOf<T extends string>(
  list: readonly T[],
  v: unknown,
  fallback: T
): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}
function oneOfOrNull<T extends string>(
  list: readonly T[],
  v: unknown
): T | null {
  return typeof v === 'string' && (list as readonly string[]).includes(v)
    ? (v as T)
    : null;
}

const CLAIM_STATES = ['sending', 'unconfirmed', 'needs_review'] as const;
const CONSENT_SOURCES = [
  'recruiter_confirmed',
  'candidate_wrote',
  'form',
] as const;

export function mapConfig(raw: unknown): AutoMsgConfig {
  const r = rec(raw);
  const s = rec(r.settings);
  const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  const triggerRows = new Map<Trigger, Rec>();
  for (const t of rows(r.triggers)) {
    const row = rec(t);
    const key = oneOfOrNull(TRIGGERS, row.trigger);
    if (key) triggerRows.set(key, row);
  }
  // All six, in the canonical order, whatever the RPC returned.
  const triggers: AutoMsgTriggerView[] = TRIGGERS.map((trigger) => {
    const row = triggerRows.get(trigger) ?? {};
    return {
      trigger,
      enabled: bool(row.enabled, false),
      templateKind: oneOf(
        TEMPLATE_KINDS,
        row.template_kind,
        DEFAULT_TRIGGER_TEMPLATE[trigger]
      ),
      channel: channelOf(row.channel),
    };
  });

  const templates: AutoMsgTemplateView[] = [];
  for (const t of rows(r.templates)) {
    const row = rec(t);
    const kind = oneOfOrNull(TEMPLATE_KINDS, row.kind);
    const language = oneOfOrNull(AUTO_LANGS, row.language);
    if (!kind || !language) continue;
    templates.push({
      kind,
      language,
      channel: channelOf(row.channel),
      body: str(row.body, ''),
      metaTemplateName: str(row.meta_template_name, ''),
      approvalStatus: oneOf(APPROVAL_STATUSES, row.approval_status, 'draft'),
      category: oneOf(TEMPLATE_CATEGORIES, row.category, 'utility'),
      updatedAt: strOrNull(row.updated_at),
    });
  }

  return {
    settings: {
      killSwitch: bool(s.kill_switch, DEFAULT_SETTINGS.killSwitch),
      quietStart: str(s.quiet_start, DEFAULT_SETTINGS.quietStart),
      quietEnd: str(s.quiet_end, DEFAULT_SETTINGS.quietEnd),
      tz: str(s.tz, DEFAULT_SETTINGS.tz),
      requiresConsent: bool(
        s.requires_consent,
        DEFAULT_SETTINGS.requiresConsent
      ),
      dailyCap: num(s.daily_cap, DEFAULT_SETTINGS.dailyCap),
      updatedAt: strOrNull(s.updated_at),
    },
    triggers,
    templates,
    role: r.role === 'admin' ? 'admin' : 'lead',
  };
}

export function mapConsent(raw: unknown): AutoMsgConsentView {
  const r = rec(raw);
  return {
    granted: typeof r.granted === 'boolean' ? r.granted : null,
    source: oneOfOrNull(CONSENT_SOURCES, r.source),
    notedAt: strOrNull(r.noted_at),
    optedOut: bool(r.opted_out, false),
    personal: bool(r.personal, false),
  };
}

export function mapOutboxRow(raw: unknown): AutoMsgOutboxRow {
  const r = rec(raw);
  return {
    id: str(r.id, ''),
    conversationId: str(r.conversation_id, ''),
    contactId: str(r.contact_id, ''),
    contactName: strOrNull(r.contact_name),
    trigger: oneOf(TRIGGERS, r.trigger, 'cv_received'),
    templateKind: oneOf(TEMPLATE_KINDS, r.template_kind, 'cv_ack'),
    language: oneOf(AUTO_LANGS, r.language, 'en'),
    status: oneOf(OUTBOX_STATUSES, r.status, 'queued'),
    holdReason: oneOfOrNull(ALL_HOLD_REASONS, r.hold_reason),
    attempts: num(r.attempts, 0),
    claimState: oneOfOrNull(CLAIM_STATES, r.claim_state),
    lastError: strOrNull(r.last_error),
    createdAt: str(r.created_at, ''),
    sentAt: strOrNull(r.sent_at),
    channel: channelOf(r.channel),
  };
}

// ---- RPC plumbing -----------------------------------------------------------

async function call<T>(
  sb: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
  map: (data: unknown) => T
): Promise<HrResult<T>> {
  try {
    const { data, error } = await sb.rpc(fn, args);
    if (error) return { error: hrErrorCode(error) };
    return { data: map(data) };
  } catch (err) {
    return { error: hrErrorCode(err) };
  }
}

// ---- wrappers ---------------------------------------------------------------

export function automsgConfig(
  sb: SupabaseClient
): Promise<HrResult<AutoMsgConfig>> {
  return call(sb, 'hr_automsg_config', {}, mapConfig);
}

/** Partial: a field left out is sent as null, which keeps the stored value. */
export function automsgSaveSettings(
  sb: SupabaseClient,
  patch: AutoMsgSettingsPatch
): Promise<HrResult<AutoMsgConfig>> {
  return call(
    sb,
    'hr_automsg_settings_set',
    {
      p_kill_switch: patch.killSwitch ?? null,
      p_quiet_start: patch.quietStart ?? null,
      p_quiet_end: patch.quietEnd ?? null,
      p_tz: patch.tz ?? null,
      p_requires_consent: patch.requiresConsent ?? null,
      p_daily_cap: patch.dailyCap ?? null,
    },
    mapConfig
  );
}

export function automsgSetTrigger(
  sb: SupabaseClient,
  trigger: Trigger,
  enabled: boolean,
  templateKind?: TemplateKind | null,
  channel?: AutomsgChannel
): Promise<HrResult<AutoMsgConfig>> {
  // p_channel only when given: the RPC's NULL default keeps the stored one.
  const args: Record<string, unknown> = {
    p_trigger: trigger,
    p_enabled: enabled,
    p_template_kind: templateKind ?? null,
  };
  if (channel) args.p_channel = channel;
  return call(sb, 'hr_automsg_trigger_set', args, mapConfig);
}

export function automsgSaveTemplate(
  sb: SupabaseClient,
  t: AutoMsgTemplateInput
): Promise<HrResult<AutoMsgConfig>> {
  return call(
    sb,
    'hr_automsg_template_set',
    {
      p_kind: t.kind,
      p_language: t.language,
      p_body: t.body,
      p_meta_template_name: t.metaTemplateName,
      p_approval_status: t.approvalStatus,
      p_category: t.category,
      p_channel: t.channel ?? 'whatsapp',
      // 317: the version the editor was filled from; null = none stored.
      p_expected: t.expectedUpdatedAt,
    },
    mapConfig
  );
}

/** The RPC returns a set; the first row is the answer. */
function firstRow(data: unknown): unknown {
  return Array.isArray(data) ? data[0] : data;
}

export function automsgConsent(
  sb: SupabaseClient,
  conversationId: string,
  channel: AutomsgChannel = 'whatsapp'
): Promise<HrResult<AutoMsgConsentView>> {
  return call(
    sb,
    'hr_automsg_consent_get',
    { p_conversation_id: conversationId, p_channel: channel },
    (d) => mapConsent(firstRow(d))
  );
}

export function automsgSetConsent(
  sb: SupabaseClient,
  conversationId: string,
  granted: boolean,
  source: ConsentSource = 'recruiter_confirmed',
  channel: AutomsgChannel = 'whatsapp'
): Promise<HrResult<AutoMsgConsentView>> {
  return call(
    sb,
    'hr_automsg_consent_set',
    {
      p_conversation_id: conversationId,
      p_granted: granted,
      p_source: source,
      p_channel: channel,
    },
    (d) => mapConsent(firstRow(d))
  );
}

export function automsgOutbox(
  sb: SupabaseClient,
  opts: { status?: OutboxStatus | null; limit?: number } = {}
): Promise<HrResult<AutoMsgOutboxRow[]>> {
  return call(
    sb,
    'hr_automsg_outbox_list',
    { p_status: opts.status ?? null, p_limit: opts.limit ?? null },
    (d) => (Array.isArray(d) ? d.map(mapOutboxRow) : [])
  );
}

export function automsgCancel(
  sb: SupabaseClient,
  id: string
): Promise<HrResult<null>> {
  return call(sb, 'hr_automsg_cancel', { p_id: id }, () => null);
}

/**
 * Whether an RCS provider is connected (`GET /api/hr/automsg/rcs`).
 * null on any failure (signed out, network, a malformed body): the caller
 * shows nothing rather than a wrong answer.
 */
export async function automsgRcsStatus(
  fetchImpl: typeof fetch = fetch
): Promise<AutoMsgRcsStatus | null> {
  try {
    const res = await fetchImpl('/api/hr/automsg/rcs', { method: 'GET' });
    if (!res.ok) return null;
    const b = rec(await res.json());
    if (typeof b.connected !== 'boolean' || typeof b.webhook !== 'boolean')
      return null;
    return { connected: b.connected, webhook: b.webhook };
  } catch {
    return null;
  }
}

/**
 * Whether the SMS gateway is connected (`GET /api/hr/automsg/sms`); null on
 * any failure, as `automsgRcsStatus`.
 */
export async function automsgSmsStatus(
  fetchImpl: typeof fetch = fetch
): Promise<AutoMsgSmsStatus | null> {
  try {
    const res = await fetchImpl('/api/hr/automsg/sms', { method: 'GET' });
    if (!res.ok) return null;
    const b = rec(await res.json());
    if (typeof b.connected !== 'boolean' || typeof b.webhook !== 'boolean')
      return null;
    return { connected: b.connected, webhook: b.webhook };
  } catch {
    return null;
  }
}

/** Runs the release pass now (route built separately). */
export async function automsgReleaseNow(): Promise<
  { data: AutoMsgReleaseSummary } | { error: string }
> {
  try {
    const res = await fetch('/api/hr/automsg/release', { method: 'POST' });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = rec(body).error;
      return {
        error:
          typeof msg === 'string' && msg
            ? msg
            : `Request failed (${res.status})`,
      };
    }
    const b = rec(body);
    const outcomes: Record<string, number> = {};
    for (const [k, v] of Object.entries(rec(b.outcomes))) {
      if (typeof v === 'number') outcomes[k] = v;
    }
    return {
      data: {
        reviewed: num(b.reviewed, 0),
        expired: num(b.expired, 0),
        outcomes,
      },
    };
  } catch {
    return { error: 'Network error' };
  }
}
