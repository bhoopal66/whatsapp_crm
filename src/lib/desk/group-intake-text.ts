/**
 * The words of the desk's reply to a file posted in a linked WhatsApp
 * group (migration 324). Pure, and plain English only: a reply goes into
 * a WhatsApp group whose members read it as a message, not as a screen in
 * their own language. Codes stay in the database (`detail`); the group
 * reads a sentence.
 */
import { docTypeLabel } from './doc-types';
import type { KnownQueueReason } from './intake-form';

/** Why a file waits in a sorting queue (220/289's queue_reason). */
export const QUEUE_REASON_TEXT: Readonly<Record<KnownQueueReason, string>> = {
  NO_KIND: 'the caption does not say what the file is',
  NO_CASE:
    'the caption does not name a case, or the new case details are incomplete',
  NO_CONTACT: 'the new case has no customer contact yet',
  NO_FILE: 'a pending document needs a file',
  CASE_NOT_FOUND: 'no open case matches that number or code',
  BANK_MISMATCH: 'that case is at a different bank',
  CASE_EXISTS_NAME_MISMATCH:
    'that licence is on file under another company name',
  COMPANY_RESTRICTED: 'this company or customer is with a colleague',
};

/** Why the desk refused the file outright (a DESK_REFUSALS hint). */
export const REFUSAL_TEXT: Readonly<Record<string, string>> = {
  NOT_ALLOWED: 'your login cannot upload to the case desk',
  FILE_INVALID: 'the file is not a readable PDF, JPEG or PNG',
  INVALID: 'the caption could not be read',
  BANK_UNKNOWN: 'the bank in the caption is not known',
  CASE_CLOSED: 'that case is closed',
  CASE_NOT_FOUND: 'no open case matches that number or code',
  COMPANY_RESTRICTED: 'this company or customer is with a colleague',
};

const FALLBACK = 'it could not be filed automatically';

export function queueReasonText(reason: string | null): string {
  return (
    (reason !== null &&
      (QUEUE_REASON_TEXT as Record<string, string>)[reason]) ||
    FALLBACK
  );
}

export function refusalText(code: string | null): string {
  return (code !== null && REFUSAL_TEXT[code]) || FALLBACK;
}

export type GroupReply =
  | { kind: 'filed'; caseNumber: string | null; docKey: string | null }
  | { kind: 'new_case'; caseNumber: string | null; captionCode: string | null }
  | { kind: 'queued'; queueName: string | null; reason: string | null }
  | { kind: 'duplicate' }
  | { kind: 'refused'; code: string | null };

/** The reply sentence for one outcome. */
export function groupReplyText(reply: GroupReply): string {
  switch (reply.kind) {
    case 'filed': {
      const where = reply.caseNumber ? ` to ${reply.caseNumber}` : '';
      const as = reply.docKey ? ` as ${docTypeLabel(reply.docKey)}` : '';
      return `Filed${where}${as}.`;
    }
    case 'new_case': {
      const opened = reply.caseNumber
        ? `New case ${reply.caseNumber} opened.`
        : 'New case opened.';
      return reply.captionCode
        ? `${opened} Caption code ${reply.captionCode}`
        : opened;
    }
    case 'queued': {
      const queue = reply.queueName
        ? `the ${reply.queueName} sorting queue`
        : 'the sorting queue';
      return `Sent to ${queue}: ${queueReasonText(reply.reason)}.`;
    }
    case 'duplicate':
      return 'Already on this case - nothing more to do.';
    case 'refused':
      return `Could not file: ${refusalText(reply.code)}.`;
    default: {
      const unknown: never = reply;
      throw new Error(`Unknown reply: ${String(unknown)}`);
    }
  }
}
