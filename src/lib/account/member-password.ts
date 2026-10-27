// ============================================================
// Setting another member's password (Settings → Members, migration 140):
// the password rule, pure so it is tested without a DOM.
//
// POST /api/account/members/[userId]/password applies `passwordProblem`
// and so does the dialog, so both refuse the same passwords. GoTrue may
// still refuse one it finds weak, and the database decides who may set
// whose password. The dialog's suggestion is `suggestPassword`
// (lib/workspaces/form), the one Add person offers.
// ============================================================

import { MIN_PASSWORD_LENGTH } from './add-member';

/** bcrypt, which GoTrue hashes passwords with, reads at most 72 bytes. */
export const MAX_PASSWORD_BYTES = 72;

export type PasswordProblem = 'required' | 'tooShort' | 'tooLong';

/** Bytes `value` takes in UTF-8, the unit of bcrypt's limit. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * The rule: at least MIN_PASSWORD_LENGTH characters and at most
 * MAX_PASSWORD_BYTES bytes in UTF-8. Null when it passes.
 */
export function passwordProblem(password: string): PasswordProblem | null {
  if (!password) return 'required';
  // Every UTF-16 unit is at least one UTF-8 byte: a long string is
  // refused before it is encoded or split.
  if (
    password.length > MAX_PASSWORD_BYTES ||
    utf8ByteLength(password) > MAX_PASSWORD_BYTES
  ) {
    return 'tooLong';
  }
  // Characters as a person counts them: an emoji is one.
  if ([...password].length < MIN_PASSWORD_LENGTH) return 'tooShort';
  return null;
}
