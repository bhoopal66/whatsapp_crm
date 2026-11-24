/**
 * Request helpers for the intake wording routes
 * (`/api/cases/config/intake-templates`, migration 183): the kinds, the
 * body check and the refusal table. Refusals answer `{ error, code }`
 * through CaseHttpError; anything else is the generic 500.
 */
import { CaseHttpError } from './http';
import { CaseStoreError } from './store';

export const INTAKE_TEMPLATE_KINDS = [
  'document_classify',
  'document_rejected',
  'document_received_next',
] as const;
export type IntakeTemplateKind = (typeof INTAKE_TEMPLATE_KINDS)[number];

/** 183's body check: 1 to 1000 characters, not blank. */
export const INTAKE_BODY_MAX = 1000;

const INVALID_TEXT = 'The wording must be 1 to 1000 characters';

/** A kind from the path, or a 404. */
export function intakeKindParam(kind: string): IntakeTemplateKind {
  if (!(INTAKE_TEMPLATE_KINDS as readonly string[]).includes(kind))
    throw new CaseHttpError(404, 'Unknown wording kind', {
      code: 'KIND_NOT_FOUND',
    });
  return kind as IntakeTemplateKind;
}

/** The body of a PUT, or a 422 TEMPLATE_INVALID (before any RPC). */
export function intakeBody(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > INTAKE_BODY_MAX ||
    /^\s*$/.test(value)
  )
    throw new CaseHttpError(422, INVALID_TEXT, { code: 'TEMPLATE_INVALID' });
  return value;
}

/**
 * The approve POST's optional `updatedAt`, passed on as text (a Date would
 * drop its microseconds), or a 400.
 */
export function intakeVersion(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(value) ||
    Number.isNaN(Date.parse(value))
  )
    throw new CaseHttpError(400, 'updatedAt is not a date');
  return value;
}

const REFUSALS: Readonly<Record<string, { status: number; text: string }>> = {
  NOT_ALLOWED: { status: 403, text: 'Not allowed' },
  SELF_APPROVAL: {
    status: 409,
    text: 'Someone else must approve wording you changed last',
  },
  TEMPLATE_INVALID: { status: 422, text: INVALID_TEXT },
  TEMPLATE_CHANGED: { status: 409, text: 'The wording was changed meanwhile' },
  TEMPLATE_NOT_FOUND: { status: 404, text: 'No wording saved for that kind' },
};

/** Throws the route's response for a failed RPC. */
export function failIntake(
  fn: string,
  error: { code?: string; hint?: string | null }
): never {
  const r = typeof error.hint === 'string' ? REFUSALS[error.hint] : undefined;
  if (r) throw new CaseHttpError(r.status, r.text, { code: error.hint });
  throw new CaseStoreError(fn, error.code ?? null);
}
