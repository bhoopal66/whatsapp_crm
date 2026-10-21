/**
 * Pure rules behind Settings -> Cases (module 018c's config routes,
 * `/api/cases/config/*`): editing a bank's stage list, warning about a
 * list the database would refuse before it is sent, the 422 code ->
 * message key map, and the wording of one SLA cell.
 *
 * `validateStages` mirrors migrations 122 and 130 (`case_bank_stages_check`) and
 * the stages route: change one, change both. The database stays the
 * judge; this only lets the screen warn before Save.
 */

import { PRESUB_STAGES } from './ui';

/** 122's final stages, spelled as the database requires. */
export const FINAL_STAGES = [
  'Approved',
  'Declined',
  'Withdrawn',
  'Closed',
] as const;

/** The stages route: at most 50 stages, each 1..100 characters. */
export const STAGES_MAX = 50;
export const STAGE_NAME_MAX = 100;

/** 122's case_banks_code_check. */
export const BANK_CODE_RE = /^[A-Z0-9_]{2,32}$/;
/** The template / document key rule of the config routes. */
export const CONFIG_KEY_RE = /^[a-z0-9_]{1,64}$/;

/** The task template the bank spaces raise for "Action needed". */
export const BANK_SPACE_TEMPLATE_KEY = 'bank_ws_action_needed';

export const SLA_TIMERS = [
  'customer_reply',
  'bank_response',
  'document_chase',
] as const;
export type SlaTimerKey = (typeof SLA_TIMERS)[number];

/** `stages` with the stage at `index` moved one place up (-1) or down (+1). */
export function moveStage(
  stages: readonly string[],
  index: number,
  direction: -1 | 1
): string[] {
  const to = index + direction;
  if (index < 0 || index >= stages.length || to < 0 || to >= stages.length)
    return [...stages];
  const next = [...stages];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** `stages` without the stage at `index`. */
export function removeStage(
  stages: readonly string[],
  index: number
): string[] {
  return stages.filter((_, i) => i !== index);
}

export type StageProblem =
  | { kind: 'empty' }
  | { kind: 'tooMany'; max: number }
  | { kind: 'blank'; position: number }
  | { kind: 'tooLong'; position: number; max: number }
  | { kind: 'duplicate'; stage: string }
  | { kind: 'presubRequired' }
  | { kind: 'firstFinal'; stage: string }
  | { kind: 'finalSpelling'; stage: string }
  | { kind: 'missingFinal'; stage: string };

/**
 * The first reason the database would refuse `stages`, or null. An empty
 * list is reported too: the screen offers "Reset to defaults" for that,
 * not Save (the route reads `[]` as a reset). Names are trimmed first,
 * as the route trims them.
 */
export function validateStages(stages: readonly string[]): StageProblem | null {
  if (stages.length === 0) return { kind: 'empty' };
  if (stages.length > STAGES_MAX) return { kind: 'tooMany', max: STAGES_MAX };
  const names = stages.map((s) => s.trim());
  for (let i = 0; i < names.length; i++) {
    if (!names[i]) return { kind: 'blank', position: i + 1 };
    if (names[i].length > STAGE_NAME_MAX)
      return { kind: 'tooLong', position: i + 1, max: STAGE_NAME_MAX };
  }
  // 130's PRESUB_STAGES_REQUIRED: the list starts with exactly the three
  // pre-submission stages, in order, and never reuses their names.
  const presubLower = PRESUB_STAGES.map((p) => p.toLowerCase());
  if (
    names.length < PRESUB_STAGES.length ||
    PRESUB_STAGES.some((p, i) => names[i] !== p) ||
    names
      .slice(PRESUB_STAGES.length)
      .some((n) => presubLower.includes(n.toLowerCase()))
  )
    return { kind: 'presubRequired' };
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) return { kind: 'duplicate', stage: name };
    seen.add(name);
  }
  // The first submission stage (position 4) must not be a final stage.
  const finalsLower = FINAL_STAGES.map((f) => f.toLowerCase());
  const firstSubmission = names[PRESUB_STAGES.length];
  if (firstSubmission && finalsLower.includes(firstSubmission.toLowerCase()))
    return { kind: 'firstFinal', stage: firstSubmission };
  for (const final of FINAL_STAGES) {
    if (names.includes(final)) continue;
    if (names.some((n) => n.toLowerCase() === final.toLowerCase()))
      return { kind: 'finalSpelling', stage: final };
    return { kind: 'missingFinal', stage: final };
  }
  return null;
}

/** The trimmed list Save sends. */
export function stagesBody(stages: readonly string[]): { stages: string[] } {
  return { stages: stages.map((s) => s.trim()) };
}

/** A 422 code of the config routes -> its key under `CaseSettings.errors`. */
const ERROR_KEYS: Record<string, string> = {
  STAGE_IN_USE: 'stageInUse',
  PRESUB_STAGES_REQUIRED: 'presubRequired',
  BANK_STAGES_FIRST_FINAL: 'firstFinal',
  BANK_STAGES_MISSING_FINAL: 'missingFinal',
  BANK_STAGES_FINAL_SPELLING: 'finalSpelling',
  STAGE_DUPLICATE: 'duplicate',
  STAGE_NOT_CONFIGURED: 'stageNotConfigured',
  INVALID: 'invalid',
  NOT_ALLOWED: 'notAllowed',
};

/**
 * The message key for a failed write's body: a known code's own key,
 * else 'generic'. The panel shows the server's `error` text beside a
 * generic message, never instead of a known one.
 */
export function configErrorKey(body: unknown): string {
  const code =
    body && typeof body === 'object' && 'code' in body
      ? (body as { code?: unknown }).code
      : undefined;
  return (typeof code === 'string' && ERROR_KEYS[code]) || 'generic';
}

/** The `error` text of a failed write's body, if any. */
export function configErrorText(body: unknown, status: number): string {
  const error =
    body && typeof body === 'object' && 'error' in body
      ? (body as { error?: unknown }).error
      : undefined;
  return typeof error === 'string' && error ? error : `HTTP ${status}`;
}

export interface SlaConfigRow {
  stage: string;
  timer: string;
  amount: number;
  unit: 'minutes' | 'days';
  dueSoonPct: number | null;
  dueSoonMinutes: number | null;
}

/** What one SLA cell says; the panel turns it into words. */
export type SlaCellLabel =
  | { kind: 'none' }
  | {
      kind: 'set';
      amount: number;
      unit: 'minutes' | 'days';
      dueSoon:
        { kind: 'pct'; pct: number } | { kind: 'minutes'; minutes: number };
    };

/** 124's default warning point when no due-soon value is stored. */
export const DEFAULT_DUE_SOON_PCT = 20;

/**
 * The label of one (stage, timer) cell: "—" with no row, else the amount
 * and its warning point. A fixed `dueSoonMinutes` wins over the percentage
 * (124's case_sla_due_soon_at reads it first).
 */
export function slaCellLabel(
  config: SlaConfigRow | null | undefined
): SlaCellLabel {
  if (!config) return { kind: 'none' };
  return {
    kind: 'set',
    amount: config.amount,
    unit: config.unit,
    dueSoon:
      config.dueSoonMinutes != null && config.dueSoonMinutes > 0
        ? { kind: 'minutes', minutes: config.dueSoonMinutes }
        : { kind: 'pct', pct: config.dueSoonPct ?? DEFAULT_DUE_SOON_PCT },
  };
}

/** The row for (stage, timer), if any. */
export function slaRowFor(
  rows: readonly SlaConfigRow[],
  stage: string,
  timer: string
): SlaConfigRow | null {
  return rows.find((r) => r.stage === stage && r.timer === timer) ?? null;
}

export interface DocumentRequirement {
  product: string;
  docKey: string;
  label: string;
  position: number;
}

/** Requirements grouped by product, products and documents in order. */
export function groupByProduct(
  rows: readonly DocumentRequirement[]
): { product: string; documents: DocumentRequirement[] }[] {
  const groups = new Map<string, DocumentRequirement[]>();
  for (const row of rows) {
    const list = groups.get(row.product) ?? [];
    list.push(row);
    groups.set(row.product, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([product, documents]) => ({
      product,
      documents: [...documents].sort(
        (a, b) => a.position - b.position || a.label.localeCompare(b.label)
      ),
    }));
}

/** A key proposed from a title or label: `Salary certificate` -> `salary_certificate`. */
export function keyFromLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

// ------------------------------------------------------------- Compass lock

export interface CaseAccountSettings {
  /** Migration 134: Compass alone sets a submitted case's core fields. */
  managedExternally: boolean;
}

/**
 * `GET|PUT /api/cases/config/settings` -> its settings, or null for an
 * answer of any other shape (the screen then shows its load error).
 */
export function parseCaseSettings(body: unknown): CaseAccountSettings | null {
  const settings =
    body && typeof body === 'object'
      ? (body as Record<string, unknown>).settings
      : null;
  if (!settings || typeof settings !== 'object') return null;
  const value = (settings as Record<string, unknown>).managedExternally;
  return typeof value === 'boolean' ? { managedExternally: value } : null;
}
