// Pure helpers for the coordinator routes (migration 133): input
// validators and the mapping from an RPC error to an HTTP answer. The
// database's own wording is never returned; the caller sees a fixed
// sentence per case.

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mirrors case_banks_code_check (122). */
export const BANK_CODE = /^[A-Z0-9_]{2,32}$/;
export const MAX_BANK_CODES = 50;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isBankCode(value: unknown): value is string {
  return typeof value === 'string' && BANK_CODE.test(value);
}

/** At most 50 distinct valid codes; an empty list is allowed (clears). */
export function isBankCodeList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_BANK_CODES &&
    value.every(isBankCode) &&
    new Set(value).size === value.length
  );
}

export interface RpcErrorLike {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
}

export interface MappedError {
  status: number;
  error: string;
}

const HINTS: Record<string, MappedError> = {
  not_eligible: {
    status: 400,
    error: 'Only a live agent or team leader can be a coordinator.',
  },
  unknown_bank: { status: 400, error: 'One of those banks does not exist.' },
  self_share: { status: 400, error: 'Share with another person.' },
  not_coordinator: {
    status: 400,
    error: 'That person is not a coordinator for this bank.',
  },
};

export function mapCoordinatorError(err: RpcErrorLike): MappedError {
  const hint = err.hint ?? '';
  if (err.code === '22023') {
    return (
      HINTS[hint] ?? { status: 400, error: 'The request was not accepted.' }
    );
  }
  if (err.code === '42501') {
    return {
      status: 403,
      error: "You don't have permission to do that.",
    };
  }
  if (err.code === 'P0002') {
    return { status: 404, error: 'Not found.' };
  }
  return { status: 500, error: 'Something went wrong. Please try again.' };
}
