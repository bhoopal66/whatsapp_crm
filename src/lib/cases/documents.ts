/**
 * The missing-documents request (module 018c, migration 123): one message
 * to the customer in the case's submission group listing every required
 * document not yet received, sent through 115's
 * SubmissionGroupService.sendFromCrm (the hosting number, the sender's
 * `Name (Label): ` prefix, the open-access-list and consent checks).
 *
 * The text is the template plus the bank's display name and the documents'
 * configured labels, nothing else. This file is on the send path, so it
 * reads no internal case text (never-sent.test.ts).
 *
 * Order: case_doc_request_begin (the case's write right; refusals throw
 * CaseRefusedError before anything is sent) → send → only after the
 * customer has the message, case_doc_mark_requested. A refused, blocked or
 * failed send marks nothing.
 */
import {
  SubmissionGroupSendBlockedError,
  SubmissionGroupSendRefusedError,
  SubmissionGroupSentNotRecordedError,
  type GroupRefusal,
  type SubmissionGroupService,
} from '@/lib/submission-groups/service';

import type { CaseToolsStore } from './tools';

/** A message template; `status` says whether its wording is approved. */
export interface MessageTemplate {
  key: string;
  status: 'IN_USE' | 'PENDING_LEGAL_REVIEW';
  text: string;
}

/** {bank} and {documents} are filled by draftMissingDocumentsRequest. */
export const MISSING_DOCUMENTS_TEMPLATE: MessageTemplate = {
  key: 'case_missing_documents',
  status: 'IN_USE',
  text: 'To continue your {bank} application we still need the following documents: {documents}. Please share them in this chat.',
};

/**
 * TEMPLATE FOR LEGAL REVIEW - NOT APPROVED WORDING. Privacy notice that
 * conversations are reviewed. Sent by nothing; legal must approve it (and
 * set its status) before any flow uses it.
 */
export const PRIVACY_NOTICE_TEMPLATE: MessageTemplate = {
  key: 'case_privacy_notice',
  status: 'PENDING_LEGAL_REVIEW',
  text: '[DRAFT - PENDING LEGAL REVIEW] Conversations in this chat may be reviewed by our team for quality and compliance purposes.',
};

/** The template with the bank name and labels inserted literally ($ is not special). */
export function draftMissingDocumentsRequest(
  bankName: string,
  labels: readonly string[]
): string {
  if (labels.length === 0)
    throw new RangeError('draftMissingDocumentsRequest: no documents');
  return MISSING_DOCUMENTS_TEMPLATE.text
    .replace('{bank}', () => bankName)
    .replace('{documents}', () => labels.join(', '));
}

export type DocRequestResult =
  | {
      sent: true;
      docKeys: string[];
      messageId: string;
      waMessageId: string;
      /** NULL when the send was not recorded (see `recorded`). */
      prefixedBody: string | null;
      /** False: WhatsApp has the message but its row was not settled. */
      recorded: boolean;
      /** Rows marked requested; NULL when marking failed after the send. */
      marked: number | null;
    }
  | { sent: false; reason: 'NOTHING_MISSING' }
  | { sent: false; reason: 'REFUSED'; refusal: GroupRefusal }
  | { sent: false; reason: 'BLOCKED'; blocked: 'opted_out' | 'do_not_contact' }
  | { sent: false; reason: 'SEND_FAILED' };

export interface DocRequestDeps {
  tools: Pick<CaseToolsStore, 'docRequestBegin' | 'docMarkRequested'>;
  sender: Pick<SubmissionGroupService, 'sendFromCrm'>;
}

/** Requests every required document of the case not yet received. */
export async function requestMissingDocuments(
  deps: DocRequestDeps,
  input: { caseId: string; actor: string }
): Promise<DocRequestResult> {
  const begin = await deps.tools.docRequestBegin(input.caseId, input.actor);
  if (begin.docKeys.length === 0)
    return { sent: false, reason: 'NOTHING_MISSING' };
  const text = draftMissingDocumentsRequest(
    begin.bankName ?? '',
    begin.docLabels
  );

  let sent: {
    messageId: string;
    waMessageId: string;
    prefixedBody: string | null;
  };
  let recorded = true;
  try {
    sent = await deps.sender.sendFromCrm({
      groupId: begin.groupId,
      userId: input.actor,
      text,
    });
  } catch (err) {
    if (err instanceof SubmissionGroupSentNotRecordedError) {
      // The customer has it: mark the documents, never invite a resend.
      sent = {
        messageId: err.messageId,
        waMessageId: err.waMessageId,
        prefixedBody: null,
      };
      recorded = false;
    } else if (err instanceof SubmissionGroupSendBlockedError) {
      return { sent: false, reason: 'BLOCKED', blocked: err.reason };
    } else if (err instanceof SubmissionGroupSendRefusedError) {
      return { sent: false, reason: 'REFUSED', refusal: err.reason };
    } else {
      return { sent: false, reason: 'SEND_FAILED' };
    }
  }

  let marked: number | null;
  try {
    marked = await deps.tools.docMarkRequested(
      input.caseId,
      input.actor,
      begin.docKeys
    );
  } catch {
    // Sent but not marked: still reported as sent, so nobody resends.
    marked = null;
  }
  return { sent: true, docKeys: begin.docKeys, ...sent, recorded, marked };
}
