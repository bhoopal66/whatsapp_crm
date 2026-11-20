/**
 * Case automation rules (migration 187), the screen side: Settings ->
 * Cases -> Automation rules and the case page's Automation list.
 *
 * Parses `/api/cases/rules` and `/api/cases/[id]/rule-runs`, checks a
 * draft before it is sent (the same limits `case_rule_validate` holds:
 * the SQL stays the judge), and words a rule and a run through the
 * `CaseRules` catalogue. No I/O.
 */
import { PRIORITIES, type CasePriority } from './types';

export const RULE_TRIGGERS = [
  'case_opened',
  'stage_changed',
  'sla_overdue',
  'no_activity',
  'submission_attached',
  // 214
  'stage_entered',
  'last_required_doc_received',
] as const;
export type RuleTrigger = (typeof RULE_TRIGGERS)[number];

export const RULE_ACTION_KINDS = [
  'assign_agent',
  'assign_coordinator',
  'add_note',
  'set_priority',
  // 214
  'create_task',
  'start_sla',
  'advance_stage',
] as const;
export type RuleActionKind = (typeof RULE_ACTION_KINDS)[number];

/** The actions every trigger but last_required_doc_received takes. */
const GENERAL_ACTION_KINDS: readonly RuleActionKind[] = [
  'assign_agent',
  'assign_coordinator',
  'add_note',
  'set_priority',
];

/**
 * 214's pairing: create_task / start_sla only on stage_entered, and
 * advance_stage alone on last_required_doc_received.
 */
export function actionKindsFor(
  trigger: RuleTrigger
): readonly RuleActionKind[] {
  if (trigger === 'last_required_doc_received') return ['advance_stage'];
  if (trigger === 'stage_entered')
    return [...GENERAL_ACTION_KINDS, 'create_task', 'start_sla'];
  return GENERAL_ACTION_KINDS;
}

export const RULE_TASK_OWNERS = ['agent', 'coordinator'] as const;
export type RuleTaskOwner = (typeof RULE_TASK_OWNERS)[number];
export const RULE_SLA_TIMERS = [
  'customer_reply',
  'bank_response',
  'document_chase',
] as const;
export type RuleSlaTimer = (typeof RULE_SLA_TIMERS)[number];

/** 187's limits, restated for the warnings shown before a save. */
export const RULE_NAME_MAX = 60;
export const RULE_CONDITION_MAX = 200;
export const RULE_NOTE_MAX = 4000;
export const RULE_ACTIONS_MAX = 5;
export const RULE_DAYS_MIN = 1;
export const RULE_DAYS_MAX = 365;
/** 214's create_task limits. */
export const RULE_TEMPLATE_KEY = /^[a-z0-9_]{1,64}$/;
export const RULE_DUE_HOURS_MIN = 1;
export const RULE_DUE_HOURS_MAX = 8760;

/** Per-action refusals a run records that have their own wording. */
export const RUN_REFUSALS = [
  'MANAGED_EXTERNALLY',
  'CASE_CLOSED',
  'ASSIGNEE_INVALID',
  // 214
  'TEMPLATE_NOT_FOUND',
  'OWNER_MISSING',
  'SLA_NOT_CONFIGURED',
  'FINAL_STAGE',
  'NO_NEXT_STAGE',
  'ADVANCE_CHAINED',
  'SUBMISSION_REQUIRED',
  'OWNER_INVALID',
  'DUE_INVALID',
  'PRESUB_REENTRY',
] as const;

export type RuleAction =
  | { kind: 'assign_agent' | 'assign_coordinator'; userId: string }
  | { kind: 'add_note'; body: string }
  | { kind: 'set_priority'; priority: CasePriority }
  | {
      kind: 'create_task';
      templateKey: string;
      ownerRole: RuleTaskOwner;
      dueHours?: number;
    }
  | { kind: 'start_sla'; timer: RuleSlaTimer }
  | { kind: 'advance_stage' };

export interface RuleConditions {
  bank_code?: string;
  stage?: string;
  product?: string;
  amount_min?: number;
  amount_max?: number;
  pre_submission?: boolean;
  days?: number;
}

export interface RuleView {
  ruleId: string;
  name: string;
  enabled: boolean;
  trigger: string;
  conditions: RuleConditions;
  actions: RuleAction[];
  position: number;
}

export interface RuleRunView {
  ruleId: string;
  trigger: string;
  matched: boolean;
  applied: { kind: string; ok: boolean; refusal: string | null }[];
  at: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const isBlank = (s: string) => /^\s*$/.test(s);
const isTrigger = (v: unknown): v is RuleTrigger =>
  typeof v === 'string' && (RULE_TRIGGERS as readonly string[]).includes(v);
const isPriority = (v: unknown): v is CasePriority =>
  typeof v === 'string' && (PRIORITIES as readonly string[]).includes(v);
const isOwner = (v: unknown): v is RuleTaskOwner =>
  typeof v === 'string' && (RULE_TASK_OWNERS as readonly string[]).includes(v);
const isTimer = (v: unknown): v is RuleSlaTimer =>
  typeof v === 'string' && (RULE_SLA_TIMERS as readonly string[]).includes(v);

function toAction(v: unknown): RuleAction | null {
  if (!isObj(v)) return null;
  switch (v.kind) {
    case 'assign_agent':
    case 'assign_coordinator':
      return typeof v.userId === 'string'
        ? { kind: v.kind, userId: v.userId }
        : null;
    case 'add_note':
      return typeof v.body === 'string'
        ? { kind: 'add_note', body: v.body }
        : null;
    case 'set_priority':
      return isPriority(v.priority)
        ? { kind: 'set_priority', priority: v.priority }
        : null;
    case 'create_task':
      return typeof v.templateKey === 'string' && isOwner(v.ownerRole)
        ? {
            kind: 'create_task',
            templateKey: v.templateKey,
            ownerRole: v.ownerRole,
            ...(typeof v.dueHours === 'number' && Number.isFinite(v.dueHours)
              ? { dueHours: v.dueHours }
              : {}),
          }
        : null;
    case 'start_sla':
      return isTimer(v.timer) ? { kind: 'start_sla', timer: v.timer } : null;
    case 'advance_stage':
      return { kind: 'advance_stage' };
    default:
      return null;
  }
}

function toConditions(v: unknown): RuleConditions {
  const out: RuleConditions = {};
  if (!isObj(v)) return out;
  for (const k of ['bank_code', 'stage', 'product'] as const)
    if (typeof v[k] === 'string') out[k] = v[k];
  for (const k of ['amount_min', 'amount_max', 'days'] as const)
    if (typeof v[k] === 'number' && Number.isFinite(v[k])) out[k] = v[k];
  if (typeof v.pre_submission === 'boolean')
    out.pre_submission = v.pre_submission;
  return out;
}

function toRule(v: unknown): RuleView | null {
  if (!isObj(v) || typeof v.ruleId !== 'string' || typeof v.name !== 'string')
    return null;
  return {
    ruleId: v.ruleId,
    name: v.name,
    enabled: v.enabled === true,
    trigger: typeof v.trigger === 'string' ? v.trigger : '',
    conditions: toConditions(v.conditions),
    actions: Array.isArray(v.actions)
      ? v.actions.map(toAction).filter((a): a is RuleAction => a !== null)
      : [],
    position: typeof v.position === 'number' ? v.position : 0,
  };
}

/** GET /api/cases/rules -> rules in position order; null when unreadable. */
export function parseRules(json: unknown): RuleView[] | null {
  if (!isObj(json) || !Array.isArray(json.rules)) return null;
  return json.rules
    .map(toRule)
    .filter((r): r is RuleView => r !== null)
    .sort((a, b) => a.position - b.position);
}

/** POST /api/cases/rules -> the saved rule; null when unreadable. */
export function parseSavedRule(json: unknown): RuleView | null {
  return isObj(json) ? toRule(json.rule) : null;
}

/** GET /api/cases/[id]/rule-runs -> runs, oldest first; null when unreadable. */
export function parseRuleRuns(json: unknown): RuleRunView[] | null {
  if (!isObj(json) || !Array.isArray(json.items)) return null;
  const out: RuleRunView[] = [];
  for (const x of json.items) {
    if (!isObj(x) || typeof x.ruleId !== 'string' || typeof x.at !== 'string')
      continue;
    out.push({
      ruleId: x.ruleId,
      trigger: typeof x.trigger === 'string' ? x.trigger : '',
      matched: x.matched === true,
      applied: Array.isArray(x.applied)
        ? x.applied.filter(isObj).map((a) => ({
            kind: typeof a.kind === 'string' ? a.kind : '',
            ok: a.ok === true,
            refusal: typeof a.refusal === 'string' ? a.refusal : null,
          }))
        : [],
      at: x.at,
    });
  }
  return out;
}

const SAVE_ERRORS = ['RULE_INVALID', 'NOT_ALLOWED', 'RULE_NOT_FOUND'] as const;
export type RuleErrorKey = (typeof SAVE_ERRORS)[number] | 'generic';

/** A refusal body `{ error, code }` -> the `CaseRules.errors` key. */
export function ruleErrorKey(body: unknown): RuleErrorKey {
  const code = isObj(body) ? body.code : null;
  return (SAVE_ERRORS as readonly unknown[]).includes(code)
    ? (code as RuleErrorKey)
    : 'generic';
}

// ---------- Draft (the editor's form state) ----------

export interface DraftAction {
  kind: RuleActionKind;
  userId: string;
  body: string;
  priority: CasePriority;
  /** create_task. */
  templateKey: string;
  ownerRole: RuleTaskOwner;
  /** '' = the template's own due hours. */
  dueHours: string;
  /** start_sla. */
  timer: RuleSlaTimer;
}

export type PreSubmissionChoice = 'any' | 'yes' | 'no';

export interface RuleDraft {
  ruleId: string | null;
  name: string;
  enabled: boolean;
  trigger: RuleTrigger;
  /** '' = any. */
  bankCode: string;
  stage: string;
  product: string;
  amountMin: string;
  amountMax: string;
  preSubmission: PreSubmissionChoice;
  /** no_activity only. */
  days: string;
  actions: DraftAction[];
  position: number | null;
}

export function newDraftAction(kind: RuleActionKind = 'add_note'): DraftAction {
  return {
    kind,
    userId: '',
    body: '',
    priority: 'normal',
    templateKey: '',
    ownerRole: 'agent',
    dueHours: '',
    timer: 'customer_reply',
  };
}

/**
 * The draft moved to another trigger: actions that trigger refuses are
 * dropped (an empty list gets the default kind), and
 * last_required_doc_received gets exactly one advance_stage.
 */
export function withTrigger(d: RuleDraft, trigger: RuleTrigger): RuleDraft {
  if (trigger === 'last_required_doc_received')
    return { ...d, trigger, actions: [newDraftAction('advance_stage')] };
  const allowed = actionKindsFor(trigger);
  const kept = d.actions.filter((a) => allowed.includes(a.kind));
  return {
    ...d,
    trigger,
    actions: kept.length > 0 ? kept : [newDraftAction()],
  };
}

export function emptyDraft(): RuleDraft {
  return {
    ruleId: null,
    name: '',
    enabled: true,
    trigger: 'case_opened',
    bankCode: '',
    stage: '',
    product: '',
    amountMin: '',
    amountMax: '',
    preSubmission: 'any',
    days: '',
    actions: [newDraftAction()],
    position: null,
  };
}

export function draftFromRule(r: RuleView): RuleDraft {
  const c = r.conditions;
  return {
    ruleId: r.ruleId,
    name: r.name,
    enabled: r.enabled,
    trigger: isTrigger(r.trigger) ? r.trigger : 'case_opened',
    bankCode: c.bank_code ?? '',
    stage: c.stage ?? '',
    product: c.product ?? '',
    amountMin: c.amount_min === undefined ? '' : String(c.amount_min),
    amountMax: c.amount_max === undefined ? '' : String(c.amount_max),
    preSubmission:
      c.pre_submission === undefined ? 'any' : c.pre_submission ? 'yes' : 'no',
    days: c.days === undefined ? '' : String(c.days),
    actions: r.actions.map((a): DraftAction => {
      const base = newDraftAction(a.kind);
      switch (a.kind) {
        case 'add_note':
          return { ...base, body: a.body };
        case 'set_priority':
          return { ...base, priority: a.priority };
        case 'assign_agent':
        case 'assign_coordinator':
          return { ...base, userId: a.userId };
        case 'create_task':
          return {
            ...base,
            templateKey: a.templateKey,
            ownerRole: a.ownerRole,
            dueHours: a.dueHours === undefined ? '' : String(a.dueHours),
          };
        case 'start_sla':
          return { ...base, timer: a.timer };
        case 'advance_stage':
          return base;
      }
    }),
    position: r.position,
  };
}

export type RuleProblem =
  | 'name_required'
  | 'name_too_long'
  | 'trigger_invalid'
  | 'days_required'
  | 'days_invalid'
  | 'condition_too_long'
  | 'amount_invalid'
  | 'amount_range'
  | 'actions_none'
  | 'actions_too_many'
  | 'person_required'
  | 'note_required'
  | 'note_too_long'
  | 'priority_invalid'
  // 214
  | 'stage_required'
  | 'action_not_allowed'
  | 'template_required'
  | 'owner_invalid'
  | 'due_hours_invalid'
  | 'timer_invalid';

/**
 * Amounts must stay below 1e16: cases.amount is numeric(18, 2) (122) and
 * 189's case_rule_validate refuses anything above 9999999999999999.99.
 */
const RULE_AMOUNT_LIMIT = 1e16;

const amount = (raw: string): number | null | 'bad' => {
  if (isBlank(raw)) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 && n < RULE_AMOUNT_LIMIT ? n : 'bad';
};

/** The problems with a draft, each once, in form order; [] = sendable. */
export function validateDraft(d: RuleDraft): RuleProblem[] {
  const out = new Set<RuleProblem>();
  if (isBlank(d.name)) out.add('name_required');
  else if (d.name.trim().length > RULE_NAME_MAX) out.add('name_too_long');
  if (!isTrigger(d.trigger)) out.add('trigger_invalid');
  if (d.trigger === 'no_activity') {
    if (isBlank(d.days)) out.add('days_required');
    else if (
      !/^\d{1,3}$/.test(d.days.trim()) ||
      Number(d.days) < RULE_DAYS_MIN ||
      Number(d.days) > RULE_DAYS_MAX
    )
      out.add('days_invalid');
  }
  if (d.trigger === 'stage_entered' && isBlank(d.stage))
    out.add('stage_required');
  if (
    [d.bankCode, d.stage, d.product].some(
      (s) => s.trim().length > RULE_CONDITION_MAX
    )
  )
    out.add('condition_too_long');
  const min = amount(d.amountMin);
  const max = amount(d.amountMax);
  if (min === 'bad' || max === 'bad') out.add('amount_invalid');
  else if (min !== null && max !== null && min > max) out.add('amount_range');
  if (d.actions.length === 0) out.add('actions_none');
  if (d.actions.length > RULE_ACTIONS_MAX) out.add('actions_too_many');
  const allowed = isTrigger(d.trigger)
    ? actionKindsFor(d.trigger)
    : RULE_ACTION_KINDS;
  for (const a of d.actions) {
    if (!allowed.includes(a.kind)) out.add('action_not_allowed');
    if (a.kind === 'create_task') {
      if (!RULE_TEMPLATE_KEY.test(a.templateKey)) out.add('template_required');
      if (!isOwner(a.ownerRole)) out.add('owner_invalid');
      if (
        !isBlank(a.dueHours) &&
        (!/^\d{1,4}$/.test(a.dueHours.trim()) ||
          Number(a.dueHours) < RULE_DUE_HOURS_MIN ||
          Number(a.dueHours) > RULE_DUE_HOURS_MAX)
      )
        out.add('due_hours_invalid');
    } else if (a.kind === 'start_sla') {
      if (!isTimer(a.timer)) out.add('timer_invalid');
    } else if (a.kind === 'advance_stage') {
      // No fields.
    } else if (a.kind === 'assign_agent' || a.kind === 'assign_coordinator') {
      if (isBlank(a.userId)) out.add('person_required');
    } else if (a.kind === 'add_note') {
      if (isBlank(a.body)) out.add('note_required');
      else if (a.body.length > RULE_NOTE_MAX) out.add('note_too_long');
    } else if (!isPriority(a.priority)) out.add('priority_invalid');
  }
  return [...out];
}

export interface RuleSaveBody {
  ruleId?: string;
  name: string;
  enabled: boolean;
  trigger: RuleTrigger;
  conditions: RuleConditions;
  actions: RuleAction[];
  position?: number;
}

/**
 * The POST body for a valid draft, else null. Blank conditions are left
 * out (absent = any); `days` goes only with no_activity, the one trigger
 * 187 accepts it on.
 */
export function draftBody(d: RuleDraft): RuleSaveBody | null {
  if (validateDraft(d).length > 0) return null;
  const conditions: RuleConditions = {};
  if (!isBlank(d.bankCode)) conditions.bank_code = d.bankCode.trim();
  if (!isBlank(d.stage)) conditions.stage = d.stage.trim();
  if (!isBlank(d.product)) conditions.product = d.product.trim();
  const min = amount(d.amountMin);
  const max = amount(d.amountMax);
  if (typeof min === 'number') conditions.amount_min = min;
  if (typeof max === 'number') conditions.amount_max = max;
  if (d.preSubmission !== 'any')
    conditions.pre_submission = d.preSubmission === 'yes';
  if (d.trigger === 'no_activity') conditions.days = Number(d.days.trim());
  const actions: RuleAction[] = d.actions.map((a): RuleAction => {
    switch (a.kind) {
      case 'add_note':
        return { kind: a.kind, body: a.body };
      case 'set_priority':
        return { kind: a.kind, priority: a.priority };
      case 'assign_agent':
      case 'assign_coordinator':
        return { kind: a.kind, userId: a.userId };
      case 'create_task':
        return {
          kind: a.kind,
          templateKey: a.templateKey,
          ownerRole: a.ownerRole,
          ...(isBlank(a.dueHours)
            ? {}
            : { dueHours: Number(a.dueHours.trim()) }),
        };
      case 'start_sla':
        return { kind: a.kind, timer: a.timer };
      case 'advance_stage':
        return { kind: a.kind };
    }
  });
  return {
    ...(d.ruleId ? { ruleId: d.ruleId } : {}),
    name: d.name.trim(),
    enabled: d.enabled,
    trigger: d.trigger,
    conditions,
    actions,
    ...(d.position !== null ? { position: d.position } : {}),
  };
}

/** The rule with `enabled` flipped, as a POST body (the list's toggle). */
export function toggleBody(r: RuleView, enabled: boolean): RuleSaveBody {
  return {
    ruleId: r.ruleId,
    name: r.name,
    enabled,
    trigger: isTrigger(r.trigger) ? r.trigger : 'case_opened',
    conditions: r.conditions,
    actions: r.actions,
    position: r.position,
  };
}

// ---------- Wording ----------

/** A translator over the `CaseRules` namespace. */
export type RulesT = (
  key: string,
  values?: Record<string, string | number>
) => string;

export interface DescribeContext {
  t: RulesT;
  locale: string;
  bankName: (code: string) => string;
  personName: (userId: string) => string;
  /** A task template's title by key; defaults to the key itself. */
  templateName?: (templateKey: string) => string;
}

function joinList(items: string[], locale: string): string {
  return new Intl.ListFormat(locale, { type: 'conjunction' }).format(items);
}

/** One sentence: "When a case is opened at ADCB, add a note". */
export function describeRule(r: RuleView, ctx: DescribeContext): string {
  const { t } = ctx;
  const c = r.conditions;
  const when = isTrigger(r.trigger)
    ? t(`describe.trigger.${r.trigger}`, {
        days: c.days ?? 0,
        stage: c.stage ?? '',
      })
    : t('describe.trigger.other');
  const parts: string[] = [];
  // stage_entered names its stage in the trigger wording already.
  const stageInWhen = r.trigger === 'stage_entered';
  if (c.bank_code !== undefined)
    parts.push(t('describe.bank', { bank: ctx.bankName(c.bank_code) }));
  if (c.stage !== undefined && !stageInWhen)
    parts.push(t('describe.stage', { stage: c.stage }));
  if (c.product !== undefined)
    parts.push(t('describe.product', { product: c.product }));
  if (c.amount_min !== undefined)
    parts.push(t('describe.amountMin', { amount: c.amount_min }));
  if (c.amount_max !== undefined)
    parts.push(t('describe.amountMax', { amount: c.amount_max }));
  if (c.pre_submission !== undefined)
    parts.push(
      t(c.pre_submission ? 'describe.preSubmission' : 'describe.submitted')
    );
  const actions = r.actions.map((a) => {
    switch (a.kind) {
      case 'add_note':
        return t('describe.action.add_note');
      case 'set_priority':
        return t('describe.action.set_priority', {
          priority: t(`priority.${a.priority}`),
        });
      case 'assign_agent':
      case 'assign_coordinator':
        return t(`describe.action.${a.kind}`, {
          person: ctx.personName(a.userId),
        });
      case 'create_task':
        return t('describe.action.create_task', {
          task: ctx.templateName?.(a.templateKey) ?? a.templateKey,
          owner: t(`describe.owner.${a.ownerRole}`),
        });
      case 'start_sla':
        return t('describe.action.start_sla', {
          timer: t(`describe.timer.${a.timer}`),
        });
      case 'advance_stage':
        return t('describe.action.advance_stage');
    }
  });
  return t('describe.sentence', {
    when: [when, ...parts].join(' '),
    actions: actions.length
      ? joinList(actions, ctx.locale)
      : t('describe.action.none'),
  });
}

/** "Matched · note added", "Matched · stopped: Managed in Compass", "Not matched". */
export function summariseRun(run: RuleRunView, t: RulesT): string {
  if (!run.matched) return t('run.notMatched');
  const parts = [t('run.matched')];
  for (const a of run.applied) {
    if (!a.ok) {
      const code = (RUN_REFUSALS as readonly string[]).includes(a.refusal ?? '')
        ? (a.refusal as string)
        : 'other';
      parts.push(t('run.stopped', { reason: t(`refusal.${code}`) }));
      break;
    }
    parts.push(
      (RULE_ACTION_KINDS as readonly string[]).includes(a.kind)
        ? t(`run.done.${a.kind}`)
        : t('run.done.other')
    );
  }
  return parts.join(' · ');
}

// ---------- Task templates (the create_task picker) ----------

export interface RuleTemplateOption {
  key: string;
  title: string;
}

/** GET /api/cases/config/banks/[code]/templates -> options in position order. */
export function parseTemplateOptions(json: unknown): RuleTemplateOption[] {
  if (!isObj(json) || !Array.isArray(json.templates)) return [];
  return json.templates
    .filter(isObj)
    .filter((r) => typeof r.templateKey === 'string')
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
    .map((r) => ({
      key: r.templateKey as string,
      title:
        typeof r.title === 'string' && !isBlank(r.title)
          ? r.title
          : (r.templateKey as string),
    }));
}

/**
 * The task picker's options. SQL looks a template up under the CASE's bank
 * only, so a rule that names a bank offers that bank's templates alone (plus
 * any key the saved rule already holds, labelled with the key if the bank no
 * longer has it). With no bank named the rule runs on every bank's cases, so
 * the banks' lists are merged, one option per key, in bank order.
 */
export function templateChoices(
  byBank: ReadonlyMap<string, RuleTemplateOption[]>,
  bankCode: string,
  storedKeys: readonly string[] = []
): RuleTemplateOption[] {
  const out = new Map<string, RuleTemplateOption>();
  const banks = bankCode ? [bankCode] : [...byBank.keys()];
  for (const code of banks)
    for (const o of byBank.get(code) ?? [])
      if (!out.has(o.key)) out.set(o.key, o);
  for (const k of storedKeys)
    if (k && !out.has(k)) out.set(k, { key: k, title: k });
  return [...out.values()];
}
