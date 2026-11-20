/**
 * HR automated messages (ported from package 025-027; migration 203 owns
 * the tables). When a recruiting event happens a fixed, pre-approved
 * TEMPLATE is queued in an outbox (in SQL) and, if every guard passes,
 * handed to a SendPort by the cron drain. There is no free-text path.
 * Everything is off by default: kill switch on, no trigger enabled.
 *
 * Client components import this file: it must import nothing outside
 * this folder.
 */

export const TRIGGERS = [
  'cv_received',
  'stage_ai_interview',
  'stage_hr_interview',
  'stage_manager_interview',
  'interview_reminder',
  'reply_overdue_nudge',
] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const TEMPLATE_KINDS = [
  'cv_ack',
  'ai_interview_invite',
  'hr_interview_invite',
  'manager_interview_invite',
  'interview_reminder',
  'reply_nudge',
] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** The template a trigger uses unless the workspace configured another kind. */
export const DEFAULT_TRIGGER_TEMPLATE: Readonly<Record<Trigger, TemplateKind>> =
  {
    cv_received: 'cv_ack',
    stage_ai_interview: 'ai_interview_invite',
    stage_hr_interview: 'hr_interview_invite',
    stage_manager_interview: 'manager_interview_invite',
    interview_reminder: 'interview_reminder',
    reply_overdue_nudge: 'reply_nudge',
  };

export const OUTBOX_STATUSES = [
  'queued',
  'held',
  'sent',
  'failed',
  'cancelled',
] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/** Guard order is the order of this list (see guards.ts `decide()`). */
export const HOLD_REASONS = [
  'kill_switch',
  'disabled',
  'closed',
  'opted_out',
  'no_consent',
  'quiet_hours',
  'outside_window_no_template',
  'daily_cap',
  'duplicate',
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** 'approved' = approved by Meta as a WhatsApp message template. Only 'approved' is ever sent automatically. */
export const APPROVAL_STATUSES = ['draft', 'approved'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Meta template category. Meta reclassifies a template by its wording; a marketing template is billed and throttled. */
export const TEMPLATE_CATEGORIES = [
  'utility',
  'marketing',
  'authentication',
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const AUTO_LANGS = ['en', 'ar'] as const;
export type AutoLang = (typeof AUTO_LANGS)[number];

/** Send attempts per outbox row; a row that failed this many times is never retried automatically. */
export const MAX_ATTEMPTS = 3;
/** A row older than this (by created_at) is cancelled instead of being sent late. */
export const MAX_HELD_HOURS = 24;

export interface TriggerSetting {
  enabled: boolean;
  templateKind: TemplateKind;
}

export interface AutoMsgSettings {
  /** Master kill switch; true blocks every automated message. Default true. */
  killSwitch: boolean;
  /** Local "HH:MM" in tz; quiet hours are [start, end), wrapping midnight when start > end; start == end = none. */
  quietStart: string;
  quietEnd: string;
  tz: string;
  /** When true a contact needs a consent record before any automated message (PDPL). Default true. */
  requiresConsent: boolean;
  /** Automated messages sent per contact per local day. Default 3. */
  dailyCap: number;
  /** Per-trigger switch; a trigger that is absent or not enabled is held 'disabled'. Default: none enabled. */
  triggers: Partial<Record<Trigger, TriggerSetting>>;
}

export const DEFAULT_SETTINGS: Readonly<AutoMsgSettings> = Object.freeze({
  killSwitch: true,
  quietStart: '21:00',
  quietEnd: '08:00',
  tz: 'Asia/Dubai',
  requiresConsent: true,
  dailyCap: 3,
  triggers: {},
});

/** A workspace's template row (camelCase of the SQL row). */
export interface StoredTemplate {
  kind: TemplateKind;
  language: AutoLang;
  /** Body with {name} / {slot} placeholders; rendered only from sanitised params. */
  body: string;
  metaTemplateName: string;
  approvalStatus: ApprovalStatus;
  category: TemplateCategory;
}

export type ClaimState = 'sending' | 'unconfirmed' | 'needs_review';

/** One outbox row (camelCase of the SQL row; rows are enqueued in SQL by migration 203). */
export interface OutboxRow {
  id: string;
  accountId: string;
  conversationId: string;
  contactId: string;
  trigger: Trigger;
  templateKind: TemplateKind;
  language: AutoLang;
  params: Record<string, string>;
  bodyRendered: string | null;
  dedupeKey: string;
  status: OutboxStatus;
  holdReason: HoldReason | null;
  attempts: number;
  claimState: ClaimState | null;
  createdAt: string;
  sentAt: string | null;
  /** Receipt state (migration 212); absent = none recorded. */
  deliveryState?: string | null;
}

/** What the guards need to know about the contact and conversation at decision time. */
export interface ContactState {
  closed: boolean;
  /** Opted out, or a withdrawn auto-message consent. */
  optedOut: boolean;
  /** A granted, not withdrawn, consent record exists. */
  consent: boolean;
  /** ISO time of the contact's last inbound message; null = never wrote. */
  lastInboundAt: string | null;
  /** Automated messages already sent to the contact today (workspace-local day). */
  sentToday: number;
}
