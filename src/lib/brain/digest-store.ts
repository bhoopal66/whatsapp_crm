/**
 * Ported from wacrm module 022d (PgDigestSource): the digest's reads over
 * supabase-js on the service role (callers pass `supabaseAdmin()`). Every
 * read is a constant number of round trips, whatever the number of cases.
 *   cases       - the case inbox (case_inbox) AS the actor: snoozed 'all',
 *                 stalest first, limit 200; buildDigest applies the open /
 *                 not-snoozed / stale rules. Cases of marked (opted-out /
 *                 deleted) contacts are dropped with ONE brain_contacts_marked.
 *   messages    - brain_digest_messages: per case only the chunks of its
 *                 newest actor-visible staff message source, marks already
 *                 applied in SQL.
 *   closedCases - ONE brain_digest_related: readable, unmarked closed cases
 *                 sharing a contact or a bank, a few newest per contact and
 *                 per bank (readability and marks are decided in SQL).
 *   tasks       - the actor's case_tasks in the account, not done, due before
 *                 the given instant (overdue included).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { CaseInbox } from '@/lib/cases/inbox';
import { date, rows, str } from '@/lib/cases/store';

import type {
  DigestCase,
  DigestMessage,
  DigestSource,
  DigestTask,
} from './digest';
import { brainFail, brainRpc } from './store';

export const DIGEST_CASES_LIMIT = 200;
/** Closed cases per contact and per bank (= DIGEST_RELATED_MAX in digest.ts). */
const RELATED_PER = 2;

const valid = (d: Date | null): d is Date =>
  d !== null && !Number.isNaN(d.getTime());

/** A SETOF uuid arrives as ["id", ...] (or [{ fn: "id" }, ...]). */
function scalars(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const x of data) {
    const v =
      typeof x === 'object' && x !== null
        ? Object.values(x)[0]
        : (x as unknown);
    if (typeof v === 'string') out.push(v);
  }
  return out;
}

export class SupabaseDigestSource implements DigestSource {
  constructor(private readonly db: SupabaseClient) {}

  async cases(
    actorId: string,
    accountId: string,
    now: Date
  ): Promise<DigestCase[]> {
    const page = await new CaseInbox(this.db).list(
      actorId,
      accountId,
      { snoozed: 'all', sort: 'stalest' },
      { now, limit: DIGEST_CASES_LIMIT }
    );
    const out: DigestCase[] = page.rows.map((r) => ({
      caseId: r.caseId,
      bankCode: r.bankCode,
      stage: r.stage,
      contactId: r.contactId,
      lastActivityAt: r.lastActivityAt,
      snoozedUntil: r.snoozedUntil,
      outcome: null,
      closedAt: r.closedAt,
    }));
    const contacts = [
      ...new Set(out.map((c) => c.contactId).filter((c): c is string => !!c)),
    ];
    if (contacts.length === 0) return out;
    const marked = new Set(
      scalars(
        await brainRpc(this.db, 'brain_contacts_marked', {
          p_account: accountId,
          p_contacts: contacts,
        })
      )
    );
    return out.filter((c) => !c.contactId || !marked.has(c.contactId));
  }

  async messages(
    actorId: string,
    accountId: string,
    since: Date
  ): Promise<DigestMessage[]> {
    const data = await brainRpc(this.db, 'brain_digest_messages', {
      p_account: accountId,
      p_actor: actorId,
      p_since: since.toISOString(),
    });
    const out: DigestMessage[] = [];
    for (const r of rows(data)) {
      const itemId = str(r.item_id);
      const sourceId = str(r.source_id);
      const caseId = str(r.case_id);
      const createdAt = date(r.created_at);
      if (!itemId || !sourceId || !caseId || !valid(createdAt)) continue;
      out.push({
        itemId,
        sourceId,
        caseId,
        contactId: str(r.contact_id),
        text: str(r.text) ?? '',
        createdBy: str(r.created_by) ?? '',
        createdAt,
      });
    }
    return out;
  }

  async closedCases(
    actorId: string,
    accountId: string,
    contactIds: string[],
    bankCodes: string[]
  ): Promise<DigestCase[]> {
    if (contactIds.length === 0 && bankCodes.length === 0) return [];
    const data = await brainRpc(this.db, 'brain_digest_related', {
      p_account: accountId,
      p_actor: actorId,
      p_contacts: contactIds,
      p_banks: bankCodes,
      p_per: RELATED_PER,
    });
    const out: DigestCase[] = [];
    for (const r of rows(data)) {
      const caseId = str(r.case_id);
      const closedAt = date(r.closed_at);
      const outcome = str(r.outcome);
      if (!caseId || !valid(closedAt) || !outcome) continue;
      out.push({
        caseId,
        bankCode: str(r.bank_code),
        stage: '',
        contactId: str(r.contact_id),
        lastActivityAt: closedAt,
        snoozedUntil: null,
        outcome,
        closedAt,
      });
    }
    return out;
  }

  async tasksDueBefore(
    actorId: string,
    accountId: string,
    before: Date
  ): Promise<DigestTask[]> {
    const { data, error } = await this.db
      .from('case_tasks')
      .select('id, case_id, title, owner_id, due_at, status')
      .eq('account_id', accountId)
      .eq('owner_id', actorId)
      .neq('status', 'done')
      .lt('due_at', before.toISOString())
      .order('due_at', { ascending: true })
      .limit(DIGEST_CASES_LIMIT);
    if (error) brainFail('case_tasks', error);
    const out: DigestTask[] = [];
    for (const r of rows(data)) {
      const taskId = str(r.id);
      const caseId = str(r.case_id);
      const dueAt = date(r.due_at);
      if (!taskId || !caseId || !valid(dueAt)) continue;
      out.push({
        taskId,
        caseId,
        title: str(r.title) ?? '',
        ownerId: str(r.owner_id) ?? '',
        dueAt,
        status: str(r.status) ?? '',
      });
    }
    return out;
  }
}
