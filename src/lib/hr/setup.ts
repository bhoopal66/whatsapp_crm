/**
 * Pure logic behind `/hr-inbox/setup`: the rule sentence, the rule
 * editor's validation and patch, and the HR team lists. The bounds
 * mirror `hr_rule_set` in migration 200 (after 1–720, due 0–720,
 * title 1–300 non-blank); the RPC re-checks and stays the authority.
 */
import type { HrRulePatch } from './api';
import {
  HR_INBOXES,
  type HrInbox,
  type HrRule,
  type HrTeamRole,
} from './types';

export const HR_AFTER_HOURS_MIN = 1;
export const HR_AFTER_HOURS_MAX = 720;
export const HR_DUE_HOURS_MIN = 0;
export const HR_DUE_HOURS_MAX = 720;
export const HR_RULE_TITLE_MAX = 300;

/** What sets a rule off, as an `Hr.setup.trigger.*` key plus its values. */
export interface RuleTrigger {
  key: 'stage' | 'topic' | 'replyOverdue' | 'noActivity';
  /** An `Hr.stage.*` / `Hr.topic.*` key for stage and topic rules. */
  labelKey?: string;
  hours?: number;
}

export function ruleTrigger(rule: HrRule): RuleTrigger {
  switch (rule.trigger_kind) {
    case 'stage':
      return { key: 'stage', labelKey: `Hr.stage.${rule.trigger_value}` };
    case 'topic':
      return { key: 'topic', labelKey: `Hr.topic.${rule.trigger_value}` };
    case 'reply_overdue':
      return { key: 'replyOverdue', hours: rule.after_hours ?? 0 };
    case 'no_activity':
      return { key: 'noActivity', hours: rule.after_hours ?? 0 };
  }
}

/** Only the time-based rules wait; only task rules have a due time and title. */
export const ruleHasAfter = (rule: HrRule): boolean =>
  rule.trigger_kind === 'reply_overdue' || rule.trigger_kind === 'no_activity';
export const ruleIsTask = (rule: HrRule): boolean => rule.action === 'task';

/** The editor's state for one rule: numbers as typed. */
export interface RuleDraft {
  enabled: boolean;
  afterHours: string;
  dueHours: string;
  title: string;
}

export function draftOf(rule: HrRule): RuleDraft {
  return {
    enabled: rule.enabled,
    afterHours: rule.after_hours == null ? '' : String(rule.after_hours),
    dueHours: rule.due_hours == null ? '' : String(rule.due_hours),
    title: rule.title ?? '',
  };
}

export type RuleDraftField = 'afterHours' | 'dueHours' | 'title';

const wholeIn = (raw: string, min: number, max: number): boolean =>
  /^\d+$/.test(raw.trim()) &&
  Number(raw.trim()) >= min &&
  Number(raw.trim()) <= max;

/** The fields of `draft` that `hr_rule_set` would refuse (INVALID). */
export function invalidFields(
  rule: HrRule,
  draft: RuleDraft
): RuleDraftField[] {
  const bad: RuleDraftField[] = [];
  if (
    ruleHasAfter(rule) &&
    !wholeIn(draft.afterHours, HR_AFTER_HOURS_MIN, HR_AFTER_HOURS_MAX)
  ) {
    bad.push('afterHours');
  }
  if (ruleIsTask(rule)) {
    if (!wholeIn(draft.dueHours, HR_DUE_HOURS_MIN, HR_DUE_HOURS_MAX)) {
      bad.push('dueHours');
    }
    if (
      /^[\s]*$/u.test(draft.title) ||
      draft.title.trim().length > HR_RULE_TITLE_MAX
    ) {
      bad.push('title');
    }
  }
  return bad;
}

/**
 * The `hrRuleSet` patch: only the fields that differ from the saved
 * rule, and only the ones the rule has. Empty means nothing to save.
 * Call after `invalidFields` came back empty.
 */
export function rulePatch(rule: HrRule, draft: RuleDraft): HrRulePatch {
  const patch: HrRulePatch = {};
  if (draft.enabled !== rule.enabled) patch.enabled = draft.enabled;
  if (ruleHasAfter(rule)) {
    const after = Number(draft.afterHours.trim());
    if (after !== rule.after_hours) patch.afterHours = after;
  }
  if (ruleIsTask(rule)) {
    const due = Number(draft.dueHours.trim());
    if (due !== rule.due_hours) patch.dueHours = due;
    const title = draft.title.trim();
    if (title !== (rule.title ?? '')) patch.title = title;
  }
  return patch;
}

export const isEmptyPatch = (patch: HrRulePatch): boolean =>
  Object.keys(patch).length === 0;

/** Rules by inbox, in the seed's order within each. */
export function rulesByInbox(rules: HrRule[]): Record<HrInbox, HrRule[]> {
  const out = { recruiter: [], dept: [] } as Record<HrInbox, HrRule[]>;
  for (const rule of rules) out[rule.inbox]?.push(rule);
  return out;
}

/** A `hr_team_members` row as the screen reads it. */
export interface HrTeamRow {
  user_id: string;
  inbox: HrInbox;
  role: HrTeamRole;
}

export interface HrTeamEntry extends HrTeamRow {
  name: string;
}

/** Each inbox's people, leads first, then by name. */
export function teamByInbox(
  rows: HrTeamRow[],
  nameOf: (userId: string) => string | null
): Record<HrInbox, HrTeamEntry[]> {
  const out = { recruiter: [], dept: [] } as Record<HrInbox, HrTeamEntry[]>;
  for (const row of rows) {
    if (!(HR_INBOXES as readonly string[]).includes(row.inbox)) continue;
    out[row.inbox].push({ ...row, name: nameOf(row.user_id) ?? row.user_id });
  }
  for (const inbox of HR_INBOXES) {
    out[inbox].sort(
      (a, b) =>
        Number(b.role === 'lead') - Number(a.role === 'lead') ||
        a.name.localeCompare(b.name)
    );
  }
  return out;
}

const STAFF_ROLES = new Set(['owner', 'admin', 'team_leader', 'agent']);

/**
 * Who can be added to an inbox: live staff (`hr_member_set` refuses
 * anyone else with NOT_FOUND) not already on it.
 */
export function addableStaff<
  P extends {
    user_id: string;
    account_role?: string | null;
    deactivated_at?: string | null;
  },
>(profiles: P[], onInbox: HrTeamRow[]): P[] {
  const taken = new Set(onInbox.map((r) => r.user_id));
  return profiles.filter(
    (p) =>
      !taken.has(p.user_id) &&
      !p.deactivated_at &&
      STAFF_ROLES.has(p.account_role ?? '')
  );
}
