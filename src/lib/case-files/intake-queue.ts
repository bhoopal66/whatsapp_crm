/**
 * The tap-to-classify intake for one webhook delivery (migration 183), in
 * two halves like the documents filer (`groupDocumentFiler`): the group
 * loop only collects customer documents and texts, in message order
 * (`document`, `text`: synchronous, never throw), and the route runs them
 * (`run`) in its `finally`, AFTER the filer, because a document's
 * `customer_documents` row exists only once it has been filed.
 *
 * With the account's `files_intake_prompts` switch off, the core returns
 * before any write or send; the reads here (case id, document id) are all
 * this costs.
 */
import type {
  GroupCustomerDocument,
  GroupCustomerText,
} from '@/lib/submission-groups/inbound';

import {
  onCustomerGroupDocument,
  onCustomerGroupText,
  type IntakePorts,
} from './intake';

export interface CaseIntakeQueueDeps {
  ports: IntakePorts;
  /** The case of a submission group, or null. */
  caseIdForGroup(groupId: string): Promise<string | null>;
  /** The filed `customer_documents.id` of a group message, or null (not filed). */
  documentIdFor(groupMessageId: number): Promise<string | null>;
  clock?: () => Date;
}

export interface CaseIntakeQueue {
  document(doc: GroupCustomerDocument): void;
  text(msg: GroupCustomerText): void;
  /** Never throws. Call after the documents filer's `run`. */
  run(): Promise<void>;
}

type Event =
  | { kind: 'document'; doc: GroupCustomerDocument }
  | { kind: 'text'; msg: GroupCustomerText };

function fileNameOf(media: Record<string, unknown>): string | null {
  const v = media.filename ?? media.file_name;
  return typeof v === 'string' && v.trim() ? v : null;
}

export function caseIntakeQueue(deps: CaseIntakeQueueDeps): CaseIntakeQueue {
  const queue: Event[] = [];
  const now = () => (deps.clock ? deps.clock() : new Date());
  return {
    document: (doc) => {
      queue.push({ kind: 'document', doc });
    },
    text: (msg) => {
      queue.push({ kind: 'text', msg });
    },
    run: async () => {
      const caseIds = new Map<string, Promise<string | null>>();
      const caseOf = (groupId: string) => {
        let p = caseIds.get(groupId);
        if (!p) {
          p = deps.caseIdForGroup(groupId);
          caseIds.set(groupId, p);
        }
        return p;
      };
      for (const e of queue.splice(0)) {
        const groupId = e.kind === 'document' ? e.doc.groupId : e.msg.groupId;
        try {
          const caseId = await caseOf(groupId);
          if (!caseId) continue;
          if (e.kind === 'document') {
            const customerDocumentId = await deps.documentIdFor(
              e.doc.groupMessageId
            );
            if (!customerDocumentId) continue;
            await onCustomerGroupDocument(deps.ports, {
              caseId,
              groupId,
              customerDocumentId,
              fileName: fileNameOf(e.doc.media),
              now: now(),
            });
          } else {
            await onCustomerGroupText(deps.ports, {
              caseId,
              body: e.msg.body,
              now: now(),
            });
          }
        } catch (error) {
          // Ids only: never message text or file names.
          console.error(
            `[case-intake] ${e.kind} of group ${groupId} failed:`,
            error instanceof Error ? error.name : 'unknown error'
          );
        }
      }
    },
  };
}
