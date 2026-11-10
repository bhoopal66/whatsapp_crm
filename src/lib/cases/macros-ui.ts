/**
 * Case macros on the client (migration 186): parsing the macro routes'
 * answers, checking a draft before it is saved, and turning an apply
 * result into lines for the case page.
 *
 * The rules restate `case_macro_validate_actions` and `case_macro_save`
 * (186) so the dialog can warn before sending; the SQL is the judge.
 * Change one, change both.
 */
import { groupEndView, type GroupEndView } from './case-page';

export const MACRO_NAME_MAX = 60;
export const MACRO_ACTIONS_MAX = 10;
export const MACRO_NOTE_MAX = 4000;
export const MACRO_STAGE_MAX = 60;
export const MACRO_DUE_HOURS_MAX = 8760;
/** 123's template key shape. */
export const MACRO_TEMPLATE_KEY_RE = /^[a-z0-9_]{1,64}$/;

export const MACRO_ACTION_KINDS = [
  'add_task',
  'add_note',
  'set_stage',
  'request_documents',
] as const;
export type MacroActionKind = (typeof MACRO_ACTION_KINDS)[number];

export const MACRO_OWNER_ROLES = ['agent', 'coordinator', 'me'] as const;
export type MacroOwnerRole = (typeof MACRO_OWNER_ROLES)[number];

/** 186's outcome list; equal to the stages that set an outcome. */
export const MACRO_OUTCOMES = ['Approved', 'Declined', 'Withdrawn'] as const;

/**
 * The placeholders a note may carry (filled by `fillNotePlaceholders` on
 * the server). Shown as code, never through an ICU message: `{{…}}` is
 * not valid ICU.
 */
export const MACRO_NOTE_PLACEHOLDERS = ['{{customer}}', '{{bank}}'] as const;

export type MacroAction =
  | {
      kind: 'add_task';
      templateKey: string;
      dueHours?: number;
      ownerRole: MacroOwnerRole;
    }
  | { kind: 'add_note'; body: string }
  | { kind: 'set_stage'; stage: string; outcome?: string }
  | { kind: 'request_documents' };

export interface CaseMacroView {
  id: string;
  ownerUserId: string;
  name: string;
  actions: MacroAction[];
  shared: boolean;
  updatedAt: string;
}

export interface AppliedActionView {
  kind: string;
  ok: boolean;
  code: string | null;
  reason: string | null;
  groupEnd: GroupEndView | null;
}

export interface ApplyResultView {
  applied: AppliedActionView[];
  documentRequestPreview: string | null;
  stoppedAt: { index: number; code: string; reason: string } | null;
}

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const isBlank = (s: string) => /^\s*$/.test(s);

/** One action as stored, or null when its shape is not one we know. */
export function parseAction(raw: unknown): MacroAction | null {
  const a = obj(raw);
  if (!a) return null;
  switch (a.kind) {
    case 'add_task': {
      const templateKey = str(a.templateKey);
      const ownerRole = str(a.ownerRole);
      if (
        templateKey === null ||
        !MACRO_OWNER_ROLES.includes(ownerRole as MacroOwnerRole)
      )
        return null;
      return typeof a.dueHours === 'number'
        ? {
            kind: 'add_task',
            templateKey,
            dueHours: a.dueHours,
            ownerRole: ownerRole as MacroOwnerRole,
          }
        : {
            kind: 'add_task',
            templateKey,
            ownerRole: ownerRole as MacroOwnerRole,
          };
    }
    case 'add_note': {
      const body = str(a.body);
      return body === null ? null : { kind: 'add_note', body };
    }
    case 'set_stage': {
      const stage = str(a.stage);
      if (stage === null) return null;
      const outcome = str(a.outcome);
      return outcome === null
        ? { kind: 'set_stage', stage }
        : { kind: 'set_stage', stage, outcome };
    }
    case 'request_documents':
      return { kind: 'request_documents' };
    default:
      return null;
  }
}

function parseMacroRow(raw: unknown): CaseMacroView | null {
  const m = obj(raw);
  if (!m) return null;
  const id = str(m.id);
  const name = str(m.name);
  const ownerUserId = str(m.ownerUserId);
  if (!id || name === null || !ownerUserId || !Array.isArray(m.actions))
    return null;
  const actions: MacroAction[] = [];
  for (const raw of m.actions) {
    const a = parseAction(raw);
    if (a) actions.push(a);
  }
  return {
    id,
    ownerUserId,
    name,
    actions,
    shared: m.shared === true,
    updatedAt: str(m.updatedAt) ?? '',
  };
}

/** `GET /api/cases/macros`; null when the answer is not a macro list. */
export function parseMacros(json: unknown): CaseMacroView[] | null {
  const list = obj(json)?.macros;
  if (!Array.isArray(list)) return null;
  return list.map(parseMacroRow).filter((m): m is CaseMacroView => m !== null);
}

/** `POST /api/cases/macros` → `{ macro }`. */
export function parseSavedMacro(json: unknown): CaseMacroView | null {
  return parseMacroRow(obj(json)?.macro);
}

/** `POST /api/cases/[id]/macros/[macroId]/apply`. */
export function parseApplyResult(json: unknown): ApplyResultView | null {
  const r = obj(json);
  if (!r || !Array.isArray(r.applied)) return null;
  const applied: AppliedActionView[] = [];
  for (const raw of r.applied) {
    const a = obj(raw);
    if (!a || typeof a.kind !== 'string' || typeof a.ok !== 'boolean') continue;
    applied.push({
      kind: a.kind,
      ok: a.ok,
      code: str(a.code),
      reason: str(a.reason),
      groupEnd: groupEndView(a.groupEnd),
    });
  }
  const s = obj(r.stoppedAt);
  const stoppedAt =
    s &&
    typeof s.index === 'number' &&
    Number.isInteger(s.index) &&
    s.index >= 0 &&
    typeof s.code === 'string'
      ? { index: s.index, code: s.code, reason: str(s.reason) ?? '' }
      : null;
  const preview = str(r.documentRequestPreview);
  return {
    applied,
    documentRequestPreview: preview && !isBlank(preview) ? preview : null,
    stoppedAt,
  };
}

// ---------- Draft validation ----------

export type ActionProblem =
  | 'templateKey'
  | 'dueHours'
  | 'ownerRole'
  | 'body'
  | 'stage'
  | 'outcome'
  | 'kind';

export type MacroProblem =
  | { kind: 'name' }
  | { kind: 'noActions' }
  | { kind: 'tooManyActions' }
  | { kind: 'action'; index: number; problem: ActionProblem };

/** The first thing wrong with one action, or null. */
export function actionProblem(a: MacroAction): ActionProblem | null {
  switch (a.kind) {
    case 'add_task':
      if (!MACRO_TEMPLATE_KEY_RE.test(a.templateKey)) return 'templateKey';
      if (
        a.dueHours !== undefined &&
        !(
          Number.isInteger(a.dueHours) &&
          a.dueHours >= 1 &&
          a.dueHours <= MACRO_DUE_HOURS_MAX
        )
      )
        return 'dueHours';
      if (!MACRO_OWNER_ROLES.includes(a.ownerRole)) return 'ownerRole';
      return null;
    case 'add_note':
      return isBlank(a.body) || a.body.length > MACRO_NOTE_MAX ? 'body' : null;
    case 'set_stage':
      if (isBlank(a.stage) || a.stage.length > MACRO_STAGE_MAX) return 'stage';
      if (
        a.outcome !== undefined &&
        !(MACRO_OUTCOMES as readonly string[]).includes(a.outcome)
      )
        return 'outcome';
      return null;
    case 'request_documents':
      return null;
    default:
      return 'kind';
  }
}

/** The first problem with a draft (name, count, then each action). */
export function validateMacroDraft(draft: {
  name: string;
  actions: readonly MacroAction[];
}): MacroProblem | null {
  const name = draft.name.trim();
  if (name === '' || name.length > MACRO_NAME_MAX) return { kind: 'name' };
  if (draft.actions.length === 0) return { kind: 'noActions' };
  if (draft.actions.length > MACRO_ACTIONS_MAX)
    return { kind: 'tooManyActions' };
  for (const [index, a] of draft.actions.entries()) {
    const problem = actionProblem(a);
    if (problem) return { kind: 'action', index, problem };
  }
  return null;
}

/**
 * The body a set_stage action stores for a stage: an outcome stage
 * carries itself as the outcome (as the case page's stage move does).
 */
export function stageAction(stage: string): MacroAction {
  return (MACRO_OUTCOMES as readonly string[]).includes(stage)
    ? { kind: 'set_stage', stage, outcome: stage }
    : { kind: 'set_stage', stage };
}

/** A fresh action of a kind, for the "add action" picker. */
export function blankAction(
  kind: MacroActionKind,
  firstTemplateKey = '',
  firstStage = ''
): MacroAction {
  switch (kind) {
    case 'add_task':
      return { kind, templateKey: firstTemplateKey, ownerRole: 'agent' };
    case 'add_note':
      return { kind, body: '' };
    case 'set_stage':
      return stageAction(firstStage);
    case 'request_documents':
      return { kind };
  }
}

/** Moves the action at `index` by -1/+1; out of range is a no-op. */
export function moveAction<T>(list: readonly T[], index: number, by: -1 | 1) {
  const to = index + by;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length)
    return [...list];
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** The POST body: a trimmed name, `shared` only when the caller may share. */
export function macroBody(
  draft: { name: string; actions: readonly MacroAction[]; shared: boolean },
  macroId: string | null,
  canShare: boolean
) {
  return {
    ...(macroId ? { macroId } : {}),
    name: draft.name.trim(),
    actions: draft.actions,
    ...(canShare ? { shared: draft.shared } : {}),
  };
}

/** A save/delete/apply refusal → CaseMacros.errors.* key. */
export function macroErrorKey(status: number, code: unknown): string {
  switch (code) {
    case 'NAME_INVALID':
      return 'nameInvalid';
    case 'ACTION_INVALID':
      return 'actionInvalid';
    case 'NOT_ALLOWED':
      return 'notAllowed';
    case 'MACRO_NOT_FOUND':
      return 'notFound';
  }
  if (status === 403) return 'notAllowed';
  if (status === 404) return 'notFound';
  return 'generic';
}

// ---------- Apply result ----------

export type ResultLine =
  | { key: 'taskAdded' }
  | { key: 'noteAdded' }
  | { key: 'stageMoved'; stage: string }
  | { key: 'documentsPreviewed' }
  | { key: 'groupEnded' | 'groupEndPending' | 'groupEndFailed' }
  | { key: 'stopped'; step: number; reason: string }
  | { key: 'unknown' };

const GROUP_LINE = {
  ended: 'groupEnded',
  pending: 'groupEndPending',
  failed: 'groupEndFailed',
} as const;

/**
 * One line per action that ran, in order, then where the run stopped.
 * `actions` is the macro as listed (the result carries kinds only, so the
 * stage name comes from it). Steps are 1-based for people.
 */
export function summariseApplyResult(
  result: ApplyResultView,
  actions: readonly MacroAction[]
): ResultLine[] {
  const lines: ResultLine[] = [];
  for (const [i, a] of result.applied.entries()) {
    if (!a.ok) continue;
    const action = actions[i];
    switch (a.kind) {
      case 'add_task':
        lines.push({ key: 'taskAdded' });
        break;
      case 'add_note':
        lines.push({ key: 'noteAdded' });
        break;
      case 'set_stage':
        lines.push({
          key: 'stageMoved',
          stage: action?.kind === 'set_stage' ? action.stage : '',
        });
        if (a.groupEnd) lines.push({ key: GROUP_LINE[a.groupEnd] });
        break;
      case 'request_documents':
        lines.push({ key: 'documentsPreviewed' });
        break;
      default:
        lines.push({ key: 'unknown' });
    }
  }
  if (result.stoppedAt) {
    const s = result.stoppedAt;
    lines.push({
      key: 'stopped',
      step: s.index + 1,
      reason: s.reason || s.code,
    });
  }
  return lines;
}
