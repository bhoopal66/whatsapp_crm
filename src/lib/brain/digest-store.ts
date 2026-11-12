/**
 * Ported from wacrm module 022d (PgDigestSource): the digest's reads over
 * supabase-js on the service role (callers pass `supabaseAdmin()`).
 *   cases       - the case inbox (case_inbox) AS the actor: snoozed 'all',
 *                 stalest first, limit 200; buildDigest applies the open /
 *                 not-snoozed / stale rules.
 *   messages    - brain_digest_messages (actor-visible staff messages).
 *   closedCases - `cases` of the account with a closed date and an outcome,
 *                 same contact or same bank, kept only where case_can_read
 *                 lets the actor see them. Only id, contact, bank, stage,
 *                 outcome and closed date are selected.
 *   tasks       - the actor's case_tasks in the account, not done, due before
 *                 the given instant (overdue included).
 * Opt-out / deletion marks are enforced HERE as well as in SQL: every case,
 * message and related case of a marked contact (brain_contact_marked) is
 * dropped before buildDigest sees it.
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
import { brainFail, brainRpc, brainScalar } from './store';

/** Rows per related-cases query (same contact, same bank). */
export const DIGEST_CLOSED_QUERY_LIMIT = 50;
export const DIGEST_CASES_LIMIT = 200;

const valid = (d: Date | null): d is Date =>
  d !== null && !Number.isNaN(d.getTime());

export class SupabaseDigestSource implements DigestSource {
  private readonly marks = new Map<string, Promise<boolean>>();

  constructor(private readonly db: SupabaseClient) {}

  private marked(accountId: string, contactId: string): Promise<boolean> {
    const key = `${accountId}:${contactId}`;
    let p = this.marks.get(key);
    if (!p) {
      p = brainRpc(this.db, 'brain_contact_marked', {
        p_account: accountId,
        p_contact: contactId,
      }).then((d) => {
        const v = brainScalar(d);
        return v === true || v === 'true';
      });
      this.marks.set(key, p);
    }
    return p;
  }

  /** Drops rows whose contact carries an opt-out / deletion mark. */
  private async unmarked<T>(
    accountId: string,
    xs: T[],
    contactOf: (r: T) => string | null
  ): Promise<T[]> {
    const contacts = [
      ...new Set(xs.map(contactOf).filter((c): c is string => !!c)),
    ];
    const flags = await Promise.all(
      contacts.map((c) => this.marked(accountId, c))
    );
    const out = new Set(contacts.filter((_, i) => flags[i]));
    return xs.filter((r) => {
      const c = contactOf(r);
      return !c || !out.has(c);
    });
  }

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
    return this.unmarked(accountId, out, (x) => x.contactId);
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
      const caseId = str(r.case_id);
      const createdAt = date(r.created_at);
      if (!itemId || !caseId || !valid(createdAt)) continue;
      out.push({
        itemId,
        caseId,
        contactId: str(r.contact_id),
        text: str(r.text) ?? '',
        createdBy: str(r.created_by) ?? '',
        createdAt,
      });
    }
    return this.unmarked(accountId, out, (x) => x.contactId);
  }

  private async closedBy(
    accountId: string,
    column: 'contact_id' | 'bank_code',
    values: string[]
  ): Promise<DigestCase[]> {
    if (values.length === 0) return [];
    const { data, error } = await this.db
      .from('cases')
      .select('id, contact_id, bank_code, stage, outcome, closed_at')
      .eq('account_id', accountId)
      .in(column, values)
      .not('closed_at', 'is', null)
      .not('outcome', 'is', null)
      .order('closed_at', { ascending: false })
      .limit(DIGEST_CLOSED_QUERY_LIMIT);
    if (error) brainFail('cases', error);
    const out: DigestCase[] = [];
    for (const r of rows(data)) {
      const caseId = str(r.id);
      const closedAt = date(r.closed_at);
      const outcome = str(r.outcome);
      if (!caseId || !valid(closedAt) || !outcome) continue;
      out.push({
        caseId,
        bankCode: str(r.bank_code),
        stage: str(r.stage) ?? '',
        contactId: str(r.contact_id),
        lastActivityAt: closedAt,
        snoozedUntil: null,
        outcome,
        closedAt,
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
    const [byContact, byBank] = await Promise.all([
      this.closedBy(accountId, 'contact_id', contactIds),
      this.closedBy(accountId, 'bank_code', bankCodes),
    ]);
    const all = [
      ...new Map([...byContact, ...byBank].map((c) => [c.caseId, c])).values(),
    ];
    const readable = await Promise.all(
      all.map(async (c) => {
        const d = await brainRpc(this.db, 'case_can_read', {
          p_case: c.caseId,
          p_user: actorId,
        });
        const v = brainScalar(d);
        return v === true || v === 'true';
      })
    );
    return this.unmarked(
      accountId,
      all.filter((_, i) => readable[i]),
      (x) => x.contactId
    );
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
