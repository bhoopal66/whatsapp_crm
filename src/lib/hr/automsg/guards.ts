/**
 * HR automated messages: one pure decision per message. The first failing
 * guard wins, in the order of HOLD_REASONS. Imports only `./types` and
 * `./templates`.
 */
import { validateTemplateBody } from './templates';
import type {
  AutoMsgSettings,
  ContactState,
  HoldReason,
  StoredTemplate,
  Trigger,
} from './types';

export type Decision = { allow: true } | { allow: false; hold: HoldReason };

export interface DecideInput {
  settings: AutoMsgSettings;
  trigger: Trigger;
  /** The trigger's switch as SQL resolved it; absent = read `settings.triggers`. */
  triggerEnabled?: boolean;
  /** The workspace's template for the row's kind and language; null = none stored. */
  template: StoredTemplate | null;
  state: ContactState;
  now: Date;
  /** The dedupe key already has an outbox row. */
  duplicate: boolean;
}

function hhmm(s: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`invalid time ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes after local midnight in tz. */
export function localMinutes(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? '0');
  return get('hour') * 60 + get('minute');
}

/** Local calendar day (YYYY-MM-DD) in tz; the daily cap counts per local day. */
export function localDay(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** [start, end) in local time; wraps midnight when start > end; start == end means no quiet hours. */
export function inQuietHours(
  now: Date,
  settings: Pick<AutoMsgSettings, 'quietStart' | 'quietEnd' | 'tz'>
): boolean {
  const s = hhmm(settings.quietStart);
  const e = hhmm(settings.quietEnd);
  if (s === e) return false;
  const t = localMinutes(now, settings.tz);
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/**
 * Guard 7: an automated send needs a Meta-approved UTILITY template whose
 * body passes `validateTemplateBody`, always, inside the 24-hour window
 * too (package fix 026d F5): there is no free-text path.
 */
export function templateSendable(t: StoredTemplate | null): boolean {
  if (!t) return false;
  if (t.approvalStatus !== 'approved') return false;
  if (t.category !== 'utility') return false;
  return validateTemplateBody(t.kind, t.body, t.category) === 'ok';
}

export function decide(i: DecideInput): Decision {
  const hold = (h: HoldReason): Decision => ({ allow: false, hold: h });
  const enabled =
    i.triggerEnabled ?? i.settings.triggers[i.trigger]?.enabled === true;
  if (i.settings.killSwitch) return hold('kill_switch');
  if (!enabled) return hold('disabled');
  if (i.state.closed) return hold('closed');
  if (i.state.optedOut) return hold('opted_out');
  if (i.settings.requiresConsent && !i.state.consent) return hold('no_consent');
  if (inQuietHours(i.now, i.settings)) return hold('quiet_hours');
  if (!templateSendable(i.template)) return hold('outside_window_no_template');
  if (i.state.sentToday >= i.settings.dailyCap) return hold('daily_cap');
  if (i.duplicate) return hold('duplicate');
  return { allow: true };
}
