/**
 * Pure view logic for the HR Automated messages screen
 * (`/hr-inbox/automated-messages`). The database decides every write
 * (migration 203's RPCs re-check the caller); this only decides what the
 * screen offers. Client components import this file: types and constants
 * only.
 */
import type { HrErrorCode, HrRoles } from '@/lib/hr/types';

import type {
  AutoMsgConfig,
  AutoMsgRcsStatus,
  AutoMsgReleaseSummary,
  AutoMsgSettingsPatch,
  AutoMsgSettingsView,
  AutoMsgTemplateView,
} from './api';
import type { AutomsgChannel } from './channel';
import {
  TRIGGERS,
  type AutoLang,
  type TemplateKind,
  type Trigger,
} from './types';

export type AutomsgRole = 'admin' | 'lead';

/** Who may use the screen: HR admins, then recruiter leads; nobody else. */
export function automsgRole(roles: HrRoles | null): AutomsgRole | null {
  if (!roles) return null;
  if (roles.admin) return 'admin';
  if (roles.recruiter === 'lead') return 'lead';
  return null;
}

export interface AutomsgControls {
  /** Kill switch, settings form, template choice, Run now. */
  editSettings: boolean;
  /** Each trigger's on/off switch. */
  switchTriggers: boolean;
}

/** Admins edit everything; a recruiter lead may only switch triggers. */
export function automsgControls(role: AutomsgRole | null): AutomsgControls {
  return {
    editSettings: role === 'admin',
    switchTriggers: role === 'admin' || role === 'lead',
  };
}

export interface BannerView {
  /** 'off' = kill switch on, nothing is sent. */
  state: 'off' | 'on';
  /** The banner's button, if this role has one. */
  action: 'turnOn' | 'turnOff' | null;
  /** Turning on asks first; turning off never does. */
  confirm: boolean;
}

export function bannerView(
  settings: Pick<AutoMsgSettingsView, 'killSwitch'>,
  role: AutomsgRole | null
): BannerView {
  const admin = automsgControls(role).editSettings;
  if (settings.killSwitch) {
    return { state: 'off', action: admin ? 'turnOn' : null, confirm: true };
  }
  return { state: 'on', action: admin ? 'turnOff' : null, confirm: false };
}

/** A trigger that cannot be switched on yet, and why (label key). */
export const UNAVAILABLE_TRIGGERS: Readonly<Partial<Record<Trigger, string>>> =
  { interview_reminder: 'needsInterviewTimes' };

export interface TriggerRowView {
  trigger: Trigger;
  enabled: boolean;
  templateKind: TemplateKind;
  approved: Record<AutoLang, boolean>;
  /** No approved version in any language: every message would be held. */
  noApproved: boolean;
  switchDisabled: boolean;
  templateDisabled: boolean;
  /** The channel the trigger's messages go out on. */
  channel: AutomsgChannel;
  /** Same permission as the on/off switch (a recruiter lead may change it). */
  channelDisabled: boolean;
  /**
   * On RCS while no RCS provider is known to be connected (status not
   * loaded counts as not connected): its messages are held, never sent.
   */
  rcsNotConnected: boolean;
  /** Label key under `automsg.triggersTable`, or null. */
  note: string | null;
}

function isApproved(
  templates: readonly AutoMsgTemplateView[],
  kind: TemplateKind,
  language: AutoLang
): boolean {
  return templates.some(
    (t) =>
      t.kind === kind &&
      t.language === language &&
      t.approvalStatus === 'approved'
  );
}

/**
 * One row per trigger, in TRIGGERS order. `rcsStatus` is
 * `automsgRcsStatus()`'s answer; null or left out = unknown.
 */
export function triggerRows(
  config: Pick<AutoMsgConfig, 'triggers' | 'templates'>,
  role: AutomsgRole | null,
  rcsStatus?: AutoMsgRcsStatus | null
): TriggerRowView[] {
  const controls = automsgControls(role);
  const byTrigger = new Map(config.triggers.map((t) => [t.trigger, t]));
  const rows: TriggerRowView[] = [];
  for (const trigger of TRIGGERS) {
    const row = byTrigger.get(trigger);
    if (!row) continue;
    const approved = {
      en: isApproved(config.templates, row.templateKind, 'en'),
      ar: isApproved(config.templates, row.templateKind, 'ar'),
    };
    const unavailable = UNAVAILABLE_TRIGGERS[trigger] ?? null;
    rows.push({
      trigger,
      enabled: row.enabled,
      templateKind: row.templateKind,
      approved,
      noApproved: !approved.en && !approved.ar,
      switchDisabled: unavailable !== null || !controls.switchTriggers,
      templateDisabled: !controls.editSettings,
      channel: row.channel,
      channelDisabled: !controls.switchTriggers,
      rcsNotConnected: row.channel === 'rcs' && rcsStatus?.connected !== true,
      note: unavailable,
    });
  }
  return rows;
}

/**
 * The page-level "RCS not connected" notice: shown only while some
 * trigger is on RCS and no provider is known to be connected.
 */
export function showRcsNotice(rows: readonly TriggerRowView[]): boolean {
  return rows.some((r) => r.rcsNotConnected);
}

export type ApprovalChipKey =
  'enApproved' | 'enMissing' | 'arApproved' | 'arMissing' | 'draftOnly';

export interface ApprovalChip {
  /** Label key under `automsg.triggersTable.chips`. */
  key: ApprovalChipKey;
  tone: 'ok' | 'missing' | 'warning';
}

/**
 * The "Approved templates" cell: one chip per language for the trigger's
 * template, then a warning chip when no language has an approved version
 * (only a draft exists, which Meta refuses outside the 24 h window).
 */
export function approvalChips(
  approved: Readonly<Record<AutoLang, boolean>>
): ApprovalChip[] {
  const chips: ApprovalChip[] = [
    approved.en
      ? { key: 'enApproved', tone: 'ok' }
      : { key: 'enMissing', tone: 'missing' },
    approved.ar
      ? { key: 'arApproved', tone: 'ok' }
      : { key: 'arMissing', tone: 'missing' },
  ];
  if (!approved.en && !approved.ar) {
    chips.push({ key: 'draftOnly', tone: 'warning' });
  }
  return chips;
}

// ---- settings form ----------------------------------------------------------

export const DAILY_CAP_MIN = 1;
export const DAILY_CAP_MAX = 20;

export interface SettingsForm {
  quietStart: string;
  quietEnd: string;
  tz: string;
  dailyCap: string;
  requiresConsent: boolean;
}

export type SettingsField = 'quietStart' | 'quietEnd' | 'tz' | 'dailyCap';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "HH:MM" for a time input; the SQL `time` may come back as "HH:MM:SS". */
export function toTimeInput(value: string): string {
  const m = /^(\d{2}:\d{2})(:\d{2}(\.\d+)?)?$/.exec(value.trim());
  return m ? m[1] : value;
}

export function settingsForm(s: AutoMsgSettingsView): SettingsForm {
  return {
    quietStart: toTimeInput(s.quietStart),
    quietEnd: toTimeInput(s.quietEnd),
    tz: s.tz,
    dailyCap: String(s.dailyCap),
    requiresConsent: s.requiresConsent,
  };
}

/** Why the config was (re)loaded: decides whether the form is reset. */
export type ConfigLoadReason = 'first' | 'settings-saved' | 'other';

/**
 * The settings form after a config load. Only the first load and a
 * successful settings save replace it; any other reload (a trigger flip,
 * a template save, Run now) keeps what the admin has typed.
 */
export function nextSettingsForm(
  current: SettingsForm | null,
  loaded: AutoMsgSettingsView,
  reason: ConfigLoadReason
): SettingsForm {
  if (current === null || reason !== 'other') return settingsForm(loaded);
  return current;
}

export type SettingsCheck =
  | { ok: true; patch: Required<Omit<AutoMsgSettingsPatch, 'killSwitch'>> }
  | { ok: false; invalid: SettingsField[] };

/** HH:MM times, a non-empty time zone, a whole daily cap of 1..20. */
export function validateSettingsForm(form: SettingsForm): SettingsCheck {
  const invalid: SettingsField[] = [];
  const quietStart = form.quietStart.trim();
  const quietEnd = form.quietEnd.trim();
  const tz = form.tz.trim();
  const capText = form.dailyCap.trim();
  const cap = /^\d+$/.test(capText) ? Number(capText) : NaN;
  if (!HHMM.test(quietStart)) invalid.push('quietStart');
  if (!HHMM.test(quietEnd)) invalid.push('quietEnd');
  if (tz === '') invalid.push('tz');
  if (!(cap >= DAILY_CAP_MIN && cap <= DAILY_CAP_MAX)) invalid.push('dailyCap');
  if (invalid.length > 0) return { ok: false, invalid };
  return {
    ok: true,
    patch: {
      quietStart,
      quietEnd,
      tz,
      dailyCap: cap,
      requiresConsent: form.requiresConsent,
    },
  };
}

// ---- refusals and Run now ---------------------------------------------------

export type AutomsgErrorKey = 'NOT_ALLOWED' | 'INVALID' | 'LIMIT' | 'UNKNOWN';

/** The `automsg.error.*` key for a refusal code; anything else is UNKNOWN. */
export function automsgErrorKey(code: HrErrorCode | string): AutomsgErrorKey {
  return code === 'NOT_ALLOWED' || code === 'INVALID' || code === 'LIMIT'
    ? code
    : 'UNKNOWN';
}

/** Run now's outcome counts folded into sent / held / other. */
export function releaseCounts(summary: AutoMsgReleaseSummary): {
  sent: number;
  held: number;
  other: number;
} {
  let sent = 0;
  let held = 0;
  let other = 0;
  for (const [k, n] of Object.entries(summary.outcomes)) {
    if (k === 'sent') sent += n;
    else if (k.startsWith('held:')) held += n;
    else other += n;
  }
  return { sent, held, other };
}
