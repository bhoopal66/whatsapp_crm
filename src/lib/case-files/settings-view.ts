/**
 * Pure rules behind Settings -> Cases -> Case files (migration 181): the
 * workspace's three file switches with the File ready stage pair
 * (`/api/cases/config/settings`), and one bank + product's file spec
 * (`/api/cases/config/banks/[code]/file-specs`).
 *
 * The routes and 181 stay the judge. `validateSpecRows` restates
 * `parseSpecRows` (lib/case-files/http.ts, server-only) plus 181's
 * DOCS_INVALID rule, and `validateReadyStages` restates
 * case_settings_set_files_ready_stages, so the screen can warn before
 * Save: change one, change both.
 */

import { CASE_FILE_UPLOAD_MIME } from './view';
import { FINAL_STAGES } from '@/lib/cases/settings-ui';
import { DEFAULT_STAGES, isPresubStage } from '@/lib/cases/ui';

// ------------------------------------------------------------ switches

export interface CaseFilesSettings {
  checklistSync: boolean;
  readyMove: boolean;
  readyFromStage: string | null;
  readyToStage: string | null;
  intakePrompts: boolean;
}

export const CASE_FILES_SWITCHES = [
  'checklistSync',
  'readyMove',
  'intakePrompts',
] as const;
export type CaseFilesSwitchKey = (typeof CASE_FILES_SWITCHES)[number];

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

const stageOrNull = (v: unknown): string | null | undefined =>
  v === null || v === undefined
    ? null
    : typeof v === 'string' && v.trim()
      ? v
      : undefined;

/**
 * The `caseFiles` object of a settings GET / PUT answer, or null for any
 * other shape. A missing switch is not read as off: the whole answer is
 * refused, so the screen never shows a guess.
 */
export function parseCaseFilesSettings(
  body: unknown
): CaseFilesSettings | null {
  const c = obj(obj(body)?.caseFiles);
  if (!c) return null;
  const { checklistSync, readyMove, intakePrompts } = c;
  const from = stageOrNull(c.readyFromStage);
  const to = stageOrNull(c.readyToStage);
  if (
    typeof checklistSync !== 'boolean' ||
    typeof readyMove !== 'boolean' ||
    typeof intakePrompts !== 'boolean' ||
    from === undefined ||
    to === undefined
  )
    return null;
  return {
    checklistSync,
    readyMove,
    readyFromStage: from,
    readyToStage: to,
    intakePrompts,
  };
}

/**
 * The PUT body taking `saved` to `draft`: only the switches that changed,
 * and both stages whenever either changed (the route takes them
 * together). Null when nothing changed.
 */
export function caseFilesSettingsBody(
  saved: CaseFilesSettings,
  draft: CaseFilesSettings
): { caseFiles: Record<string, boolean | string | null> } | null {
  const caseFiles: Record<string, boolean | string | null> = {};
  for (const key of CASE_FILES_SWITCHES)
    if (saved[key] !== draft[key]) caseFiles[key] = draft[key];
  if (
    saved.readyFromStage !== draft.readyFromStage ||
    saved.readyToStage !== draft.readyToStage
  ) {
    caseFiles.readyFromStage = draft.readyFromStage;
    caseFiles.readyToStage = draft.readyToStage;
  }
  return Object.keys(caseFiles).length ? { caseFiles } : null;
}

/**
 * The stages a File ready move may name: 181 judges against the default
 * stage list, minus the pre-submission and final stages, in order.
 */
export function readyStageOptions(
  stages: readonly string[] = DEFAULT_STAGES
): string[] {
  const finals = FINAL_STAGES.map((f) => f.toLowerCase());
  return stages.filter(
    (s) => !isPresubStage(s) && !finals.includes(s.toLowerCase())
  );
}

export type ReadyStagesProblem =
  'incomplete' | 'notSelectable' | 'same' | 'order';

/**
 * Why case_settings_set_files_ready_stages would refuse the pair, or
 * null. Both null clears and is fine, unless the move is switched on
 * (`required`): a move with no stages has nowhere to go.
 */
export function validateReadyStages(
  from: string | null,
  to: string | null,
  required: boolean
): ReadyStagesProblem | null {
  if (from === null && to === null) return required ? 'incomplete' : null;
  if (from === null || to === null) return 'incomplete';
  const options = readyStageOptions();
  const i = options.indexOf(from);
  const j = options.indexOf(to);
  if (i < 0 || j < 0) return 'notSelectable';
  if (i === j) return 'same';
  return i < j ? null : 'order';
}

// ------------------------------------------------------------ file spec

/** 181's allowed_mime universe (equals SPEC_MIME_TYPES in http.ts). */
export const SPEC_MIME_TYPES: readonly string[] = CASE_FILE_UPLOAD_MIME;
/** case_file_spec_rows' name pattern when no spec is stored. */
export const DEFAULT_NAME_PATTERN = '{{case}}_{{doc}}_{{yyyymmdd}}';
export const NAME_PLACEHOLDERS = [
  '{{case}}',
  '{{company}}',
  '{{doc}}',
  '{{yyyymmdd}}',
] as const;
export const NAME_PATTERN_MAX = 200;
export const POSITION_MAX = 999_999_999;
export const MAX_MB_MAX = 100;
export const MIN_VALID_DAYS_MAX = 3650;
/** 181's column defaults. */
export const DEFAULT_MAX_MB = 10;
export const DEFAULT_MERGED = true;

export interface SpecRequirement {
  docKey: string;
  label: string;
}

export interface SpecRow {
  docKey: string;
  position: number;
  namePattern: string;
  required: boolean;
  maxMb: number;
  allowedMime: string[];
  minValidDays: number | null;
  merged: boolean;
}

export interface FileSpecView {
  product: string;
  requirements: SpecRequirement[];
  rows: SpecRow[];
  usesDefaults: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function requirementOf(v: unknown): SpecRequirement | null {
  const r = obj(v);
  const docKey = str(r?.docKey);
  if (!r || !docKey) return null;
  return { docKey, label: str(r.label) || docKey };
}

function specRowOf(v: unknown): SpecRow | null {
  const r = obj(v);
  if (!r) return null;
  const docKey = str(r.docKey);
  const position = num(r.position);
  const maxMb = num(r.maxMb);
  const minValidDays = r.minValidDays == null ? null : num(r.minValidDays);
  if (
    !docKey ||
    position === null ||
    maxMb === null ||
    (r.minValidDays != null && minValidDays === null) ||
    !Array.isArray(r.allowedMime)
  )
    return null;
  return {
    docKey,
    position,
    namePattern: str(r.namePattern) ?? DEFAULT_NAME_PATTERN,
    required: r.required === true,
    maxMb,
    allowedMime: r.allowedMime.filter(
      (m): m is string => typeof m === 'string'
    ),
    minValidDays,
    merged: r.merged !== false,
  };
}

/** A file-specs GET answer, or null for any other shape; junk rows are dropped. */
export function parseFileSpec(body: unknown): FileSpecView | null {
  const b = obj(body);
  const product = str(b?.product);
  if (
    !b ||
    product === null ||
    !Array.isArray(b.requirements) ||
    !Array.isArray(b.rows)
  )
    return null;
  const keep = <T>(list: unknown[], of: (v: unknown) => T | null): T[] =>
    list.map(of).filter((x): x is T => x !== null);
  const rows = keep(b.rows, specRowOf);
  return {
    product,
    requirements: keep(b.requirements, requirementOf),
    rows,
    usesDefaults:
      typeof b.usesDefaults === 'boolean' ? b.usesDefaults : rows.length === 0,
  };
}

/**
 * The GET's `rows` exactly as they came, for the PUT's `expected`:
 * `parseFileSpec` may normalise or drop some, and the database compares
 * with what is stored.
 */
export function specExpected(body: unknown): unknown[] | undefined {
  const rows = obj(body)?.rows;
  return Array.isArray(rows) ? rows : undefined;
}

/** One editable row: the number fields as typed. */
export interface SpecRowDraft {
  docKey: string;
  label: string;
  position: string;
  namePattern: string;
  required: boolean;
  maxMb: string;
  allowedMime: string[];
  minValidDays: string;
}

export interface SpecDraft {
  rows: SpecRowDraft[];
  merged: boolean;
}

/**
 * The editor's starting point: one row per required document, from the
 * stored spec where it has one, else 181's defaults (position in list
 * order, required, 10 MB, every type, no minimum, the default name).
 * A stored row for a document no longer on the list is left out.
 */
export function specDraft(view: FileSpecView): SpecDraft {
  const stored = new Map(view.rows.map((r) => [r.docKey, r]));
  const rows = view.requirements.map((req, i): SpecRowDraft => {
    const r = stored.get(req.docKey);
    return {
      docKey: req.docKey,
      label: req.label,
      position: String(r?.position ?? i + 1),
      namePattern: r?.namePattern ?? DEFAULT_NAME_PATTERN,
      required: r?.required ?? true,
      maxMb: String(r?.maxMb ?? DEFAULT_MAX_MB),
      allowedMime: r ? [...r.allowedMime] : [...SPEC_MIME_TYPES],
      minValidDays: r?.minValidDays == null ? '' : String(r.minValidDays),
    };
  });
  const merged = view.rows[0]?.merged ?? DEFAULT_MERGED;
  return { rows, merged };
}

/** A typed whole number, else NaN (so it fails every range check). */
function intOf(raw: string): number {
  const t = raw.trim();
  return /^-?\d+$/.test(t) ? Number(t) : NaN;
}

/** The rows a draft would send. Blank min valid days is no minimum. */
export function specRowsFromDraft(draft: SpecDraft): SpecRow[] {
  return draft.rows.map((r) => ({
    docKey: r.docKey,
    position: intOf(r.position),
    namePattern: r.namePattern,
    required: r.required,
    maxMb: intOf(r.maxMb),
    allowedMime: SPEC_MIME_TYPES.filter((m) => r.allowedMime.includes(m)),
    minValidDays: r.minValidDays.trim() === '' ? null : intOf(r.minValidDays),
    merged: draft.merged,
  }));
}

export type SpecProblem =
  | { kind: 'unknownDoc'; docKey: string }
  | { kind: 'duplicateDoc'; docKey: string }
  | { kind: 'position'; docKey: string }
  | { kind: 'duplicatePosition'; position: number }
  | { kind: 'maxMb'; docKey: string }
  | { kind: 'mime'; docKey: string }
  | { kind: 'minValidDays'; docKey: string }
  | { kind: 'namePattern'; docKey: string }
  | { kind: 'merged' };

const intIn = (v: number, min: number, max: number) =>
  Number.isInteger(v) && v >= min && v <= max;

/** Not blank, at most 200 characters, only the four placeholders. */
export function isNamePattern(v: string): boolean {
  return (
    !/^\s*$/.test(v) &&
    [...v].length <= NAME_PATTERN_MAX &&
    !/\{\{|\}\}/.test(v.replace(/\{\{(case|company|doc|yyyymmdd)\}\}/g, ''))
  );
}

/**
 * The first reason the route or 181 would refuse `rows`, or null. An
 * empty list is not a problem: it is "Reset to defaults".
 */
export function validateSpecRows(
  rows: readonly SpecRow[],
  requirements: readonly SpecRequirement[]
): SpecProblem | null {
  const known = new Set(requirements.map((r) => r.docKey));
  const keys = new Set<string>();
  const positions = new Set<number>();
  for (const r of rows) {
    if (!known.has(r.docKey)) return { kind: 'unknownDoc', docKey: r.docKey };
    if (keys.has(r.docKey)) return { kind: 'duplicateDoc', docKey: r.docKey };
    keys.add(r.docKey);
    if (!intIn(r.position, 1, POSITION_MAX))
      return { kind: 'position', docKey: r.docKey };
    if (positions.has(r.position))
      return { kind: 'duplicatePosition', position: r.position };
    positions.add(r.position);
    if (!intIn(r.maxMb, 1, MAX_MB_MAX))
      return { kind: 'maxMb', docKey: r.docKey };
    if (
      r.allowedMime.length === 0 ||
      r.allowedMime.some((m) => !SPEC_MIME_TYPES.includes(m)) ||
      new Set(r.allowedMime).size !== r.allowedMime.length
    )
      return { kind: 'mime', docKey: r.docKey };
    if (
      r.minValidDays !== null &&
      !intIn(r.minValidDays, 0, MIN_VALID_DAYS_MAX)
    )
      return { kind: 'minValidDays', docKey: r.docKey };
    if (!isNamePattern(r.namePattern))
      return { kind: 'namePattern', docKey: r.docKey };
  }
  if (new Set(rows.map((r) => r.merged)).size > 1) return { kind: 'merged' };
  return null;
}

/** The PUT body; `rows: []` removes the spec (back to defaults). */
export function specBody(
  product: string,
  rows: readonly SpecRow[]
): { product: string; rows: SpecRow[] } {
  return { product, rows: rows.map((r) => ({ ...r })) };
}

/** A refusal code of these routes -> its key under `CaseFilesSettings.errors`. */
const ERROR_KEYS: Record<string, string> = {
  SPEC_INVALID: 'specInvalid',
  SPEC_CHANGED: 'specChanged',
  DOCS_INVALID: 'docsInvalid',
  BANK_UNKNOWN: 'bankUnknown',
  SETTING_INVALID: 'settingInvalid',
  NOT_ALLOWED: 'notAllowed',
  SELF_APPROVAL: 'selfApproval',
  TEMPLATE_CHANGED: 'templateChanged',
  TEMPLATE_INVALID: 'templateInvalid',
};

/** The message key for a failed write's body: a known code's, else 'generic'. */
export function caseFilesErrorKey(body: unknown, status: number): string {
  const code = obj(body)?.code;
  if (typeof code === 'string' && ERROR_KEYS[code]) return ERROR_KEYS[code];
  return status === 403 ? 'notAllowed' : 'generic';
}

// --- WhatsApp intake wording (document_intake templates) -------------------

export const INTAKE_KINDS = [
  'document_classify',
  'document_rejected',
  'document_received_next',
] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

/** The placeholders each message may use (shown as a hint, not validated). */
export const INTAKE_PLACEHOLDERS: Record<IntakeKind, readonly string[]> = {
  document_classify: ['{file}', '{list}'],
  document_rejected: ['{doc}', '{checks}'],
  document_received_next: ['{doc}', '{list}'],
};

export const INTAKE_BODY_MAX = 1000;

export interface IntakeTemplateView {
  kind: IntakeKind;
  body: string | null;
  approved: boolean;
  /** The version an approval names; kept as text (microseconds). */
  updatedAt: string | null;
}

/** Always the three kinds, in order; anything unreadable is "no wording". */
export function parseIntakeTemplates(payload: unknown): IntakeTemplateView[] {
  const list = obj(payload)?.templates;
  const rows = Array.isArray(list) ? list : [];
  return INTAKE_KINDS.map((kind) => {
    const row = rows.map(obj).find((r) => r?.kind === kind);
    const body = typeof row?.body === 'string' ? row.body : null;
    return {
      kind,
      body,
      approved: body !== null && row?.approved === true,
      updatedAt: body === null ? null : str(row?.updatedAt),
    };
  });
}

/** The texts after a re-read: what was typed stays, the rest follows. */
export function refreshedDrafts(
  before: readonly IntakeTemplateView[],
  after: readonly IntakeTemplateView[],
  drafts: Readonly<Record<string, string>>
): Record<string, string> {
  return Object.fromEntries(
    after.map((row) => {
      const old = before.find((r) => r.kind === row.kind)?.body ?? '';
      const typed = drafts[row.kind] ?? '';
      return [row.kind, typed === old ? (row.body ?? '') : typed];
    })
  );
}

/** Why a wording cannot be saved, or null. */
export function templateBodyProblem(body: string): 'blank' | 'tooLong' | null {
  if (/^\s*$/.test(body)) return 'blank';
  return body.length > INTAKE_BODY_MAX ? 'tooLong' : null;
}
