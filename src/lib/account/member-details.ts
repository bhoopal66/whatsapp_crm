// ============================================================
// Editing another member's details (Settings → Members, migration 167):
// their name and login email. Pure so the rule is tested without a DOM.
//
// PATCH /api/account/members/[userId]/details applies
// `memberNameProblem` / `memberEmailProblem` and so does the dialog, so both refuse the same
// input. GoTrue may still refuse an email (taken by another login), and
// the database decides who may edit whose details
// (`authorize_member_details_change`).
// ============================================================

/** Settings → Profile caps a person's own name at the same length. */
export const MAX_MEMBER_NAME_LENGTH = 120;

/** RFC 5321's limit on a whole address. */
export const MAX_MEMBER_EMAIL_LENGTH = 254;

/** A rough shape check; GoTrue is the real validator. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface MemberDetailsInput {
  full_name: string;
  email: string;
}

export type MemberDetailsProblem =
  | 'nameRequired'
  | 'nameTooLong'
  | 'emailRequired'
  | 'emailInvalid'
  | 'emailTooLong';

/** The form's values as they are stored: name trimmed, email trimmed and
 *  lower-cased (GoTrue stores addresses lower-cased). */
export function normalizeMemberDetails(
  input: MemberDetailsInput
): MemberDetailsInput {
  return {
    full_name: input.full_name.trim(),
    email: input.email.trim().toLowerCase(),
  };
}

/** The problem with an already-normalised name, or null. */
export function memberNameProblem(
  full_name: string
): MemberDetailsProblem | null {
  if (!full_name) return 'nameRequired';
  if ([...full_name].length > MAX_MEMBER_NAME_LENGTH) return 'nameTooLong';
  return null;
}

/** The problem with an already-normalised email, or null. */
export function memberEmailProblem(email: string): MemberDetailsProblem | null {
  if (!email) return 'emailRequired';
  if (email.length > MAX_MEMBER_EMAIL_LENGTH) return 'emailTooLong';
  if (!EMAIL_RE.test(email)) return 'emailInvalid';
  return null;
}

/** The first problem with already-normalised details, or null. */
export function memberDetailsProblem(
  details: MemberDetailsInput
): MemberDetailsProblem | null {
  return (
    memberNameProblem(details.full_name) ?? memberEmailProblem(details.email)
  );
}
