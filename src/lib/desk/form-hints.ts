/**
 * Why a desk button is disabled, as a code the form turns into plain
 * English beside the button. Pure: each function answers "what is still
 * missing", `null` meaning the button may be pressed. `busy` is not a
 * reason (the button already says it is working).
 */

/** Upload: a pending document needs its file (the server's NO_FILE). */
export function uploadBlock(i: {
  kind: string;
  hasFile: boolean;
}): 'fileNeeded' | null {
  return i.kind === 'pending_doc' && !i.hasFile ? 'fileNeeded' : null;
}

/** Filing a sorting-queue item to a case. */
export function sortFileBlock(i: {
  found: boolean;
  mismatch: boolean;
  confirmed: boolean;
}): 'noCase' | 'confirm' | null {
  if (!i.found) return 'noCase';
  if (i.mismatch && !i.confirmed) return 'confirm';
  return null;
}

export type NewCaseField =
  'company' | 'licence' | 'bank' | 'product' | 'contact';

/** The fields still missing before a new case can be opened, in form order. */
export function newCaseMissing(i: {
  legalName: string;
  licence: string;
  bankCode: string;
  product: string;
  hasContact: boolean;
}): NewCaseField[] {
  const out: NewCaseField[] = [];
  if (i.legalName.trim() === '') out.push('company');
  if (i.licence.trim() === '') out.push('licence');
  if (i.bankCode === '') out.push('bank');
  if (i.product.trim() === '') out.push('product');
  if (!i.hasContact) out.push('contact');
  return out;
}

/** Rejecting needs a reason the uploader will see. */
export function rejectBlock(reason: string): 'reason' | null {
  return reason.trim() === '' ? 'reason' : null;
}

/** Filing a tray document. */
export function trayFileBlock(i: {
  picked: boolean;
  mustConfirm: boolean;
  confirm: string;
}): 'pick' | 'confirm' | null {
  if (!i.picked) return 'pick';
  if (i.mustConfirm && i.confirm.trim() === '') return 'confirm';
  return null;
}

/** The shortest reason the tray accepts for dismissing a document. */
export const TRAY_DISMISS_MIN_CHARS = 3;

export function trayDismissBlock(reason: string): 'reason' | null {
  return reason.trim().length < TRAY_DISMISS_MIN_CHARS ? 'reason' : null;
}
