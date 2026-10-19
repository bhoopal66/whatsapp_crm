/**
 * The case bank contact log (module 018c, migration 124). INTERNAL and
 * append-only: what was said to the bank never reaches the customer. No
 * send-path module may import this file or name its table;
 * never-sent.test.ts scans for both.
 *
 *   add  — case_bank_contact_add (the case's write rule; who, when and what
 *          was said are required: CONTACT_INCOMPLETE; caps: TEXT_TOO_LONG).
 *   list — the case's contacts in contact order (no access decision).
 */
import { CaseRpc } from './rpc';
import { date, str } from './store';

/** 124's caps (characters): its CHECKs and case_bank_contact_add agree. */
export const BANK_CONTACT_CAPS = {
  contactName: 200,
  summary: 4000,
  nextAction: 4000,
} as const;

export interface BankContact {
  id: string;
  caseId: string;
  contactName: string;
  contactedAt: Date;
  summary: string;
  nextAction: string | null;
  nextActionAt: Date | null;
  authorId: string;
  createdAt: Date;
}

export class CaseBankContactsStore extends CaseRpc {
  /** Returns the new row's id. */
  async add(input: {
    caseId: string;
    actor: string;
    contactName: string;
    contactedAt: Date;
    summary: string;
    nextAction?: string | null;
    nextActionAt?: Date | null;
  }): Promise<string> {
    const data = await this.rpc('case_bank_contact_add', {
      p_case: input.caseId,
      p_actor: input.actor,
      p_contact_name: input.contactName,
      p_contacted_at: input.contactedAt.toISOString(),
      p_summary: input.summary,
      p_next_action: input.nextAction ?? null,
      p_next_action_at: input.nextActionAt
        ? input.nextActionAt.toISOString()
        : null,
      p_now: this.now(),
    });
    return String(data);
  }

  async list(caseId: string): Promise<BankContact[]> {
    const data = await this.select(
      'case_bank_contacts',
      'id, case_id, contact_name, contacted_at, summary, next_action, next_action_at, author_id, created_at',
      { case_id: caseId },
      ['contacted_at', 'created_at', 'id']
    );
    return data.map((b) => ({
      id: String(b.id),
      caseId: String(b.case_id),
      contactName: String(b.contact_name),
      contactedAt: date(b.contacted_at)!,
      summary: String(b.summary),
      nextAction: str(b.next_action),
      nextActionAt: date(b.next_action_at),
      authorId: String(b.author_id),
      createdAt: date(b.created_at)!,
    }));
  }
}
