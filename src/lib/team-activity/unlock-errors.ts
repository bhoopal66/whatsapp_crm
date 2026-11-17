// ============================================================
// Maps an error from the unlock tables and functions (migration 204)
// to the HTTP answer the routes give. Kept out of the route files,
// which may export only handlers.
// ============================================================

import { UNLOCKS_UNAVAILABLE_MESSAGE, isMissingObject } from './db-errors';

export interface RpcErrorLike {
  code?: string;
  message?: string;
  hint?: string | null;
}

export function unlockErrorResponse(
  error: RpcErrorLike,
  label: string
): { status: number; body: { error: string } } {
  if (isMissingObject(error)) {
    return { status: 503, body: { error: UNLOCKS_UNAVAILABLE_MESSAGE } };
  }
  const hint = error.hint ?? '';
  switch (error.code) {
    case '42501':
      return { status: 403, body: { error: 'You cannot do that' } };
    case 'P0002':
      return { status: 404, body: { error: 'Not found' } };
    case '23505':
      return { status: 409, body: { error: 'Already requested' } };
    case 'P0001':
      if (hint === 'already_decided') {
        return { status: 409, body: { error: 'Already decided' } };
      }
      if (hint === 'already_pending') {
        return { status: 409, body: { error: 'Already requested' } };
      }
      break;
    case '22023':
    case '22P02':
      return { status: 400, body: { error: 'Invalid request' } };
  }
  console.error(`[team-activity/unlocks] ${label} failed:`, error.message);
  return { status: 500, body: { error: 'Something went wrong' } };
}
