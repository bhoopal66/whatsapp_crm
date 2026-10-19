/**
 * A case's customer conversation for the people working it (module 018c),
 * audited. Service role throughout; Postgres decides every access.
 *
 * read(actor, caseId)
 *   1. store.viewCases(actor, [caseId]) FIRST: view_case writes one
 *      case_view_audit row per readable case for a coordinator, team lead,
 *      admin or super admin (an agent's views are not audited) and returns
 *      the readable ids. A read that throws later cannot undo that row.
 *   2. Not readable: { allowed: false }, and nothing else is read.
 *   3. ENDED group: ONLY 115's viewArchive({ groupId, userId }), unchanged
 *      (its own window and audit). ACTIVE: the live messages, post_end
 *      rows excluded.
 *
 * reply(actor, caseId, text): the case write gate (case_role +
 *   canWriteCase, i.e. case_rule_can_write) comes first; then 115's
 *   guarded sendFromCrm (opt-out respected). Its errors pass through typed.
 *
 * takeOver(actor, caseId, { agentName, bankName }): for the coordinator of
 *   the case or the team lead of its team (128 decides). Reassigns nothing.
 *   1. The hand-over template must be APPROVED, or allowDraftTemplate
 *      (tests only); otherwise TEMPLATE_NOT_APPROVED: nothing logged or sent.
 *   2. Names and version are validated (NAME_INVALID / TEMPLATE_INVALID)
 *      before anything is logged.
 *   3. case_takeover_record writes the log row (NOT_ALLOWED for anyone
 *      else), THEN sendFromCrm. The row STAYS when the send is then blocked
 *      or refused: it records the attempt.
 *
 * ACTIVE WORKSPACE (as store.ts): a route checks the case's account is the
 * caller's active one before calling any of these.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { SubmissionGroupService } from '@/lib/submission-groups/service';
import type { GroupMessage } from '@/lib/submission-groups/store';

import { canWriteCase } from './access';
import { liveGroupMessages, loadCaseGroup } from './case-group';
import {
  HANDOVER_TEMPLATE_DRAFT,
  validateHandover,
  type HandoverTemplate,
} from './handover';
import { CaseRefusedError, CaseStoreError } from './store';
import type { CaseStore } from './store';

export type CaseConversationRead =
  | { allowed: false }
  | {
      allowed: true;
      /** NULL: the case has no group row. */
      groupId: string | null;
      /** true when read from 115's archive of an ENDED group. */
      archived: boolean;
      messages: GroupMessage[];
    };

export type TakeOverRefusal =
  | 'TEMPLATE_NOT_APPROVED'
  | 'TEMPLATE_INVALID'
  | 'NAME_INVALID'
  | 'NOT_ALLOWED'
  | 'CASE_NOT_FOUND';
const TAKEOVER_HINTS = new Set<string>([
  'TEMPLATE_INVALID',
  'NOT_ALLOWED',
  'CASE_NOT_FOUND',
]);

export class CaseTakeOverRefusedError extends Error {
  override readonly name = 'CaseTakeOverRefusedError';
  constructor(readonly reason: TakeOverRefusal) {
    super(`case take-over refused: ${reason}`);
  }
}

export interface SentMessage {
  messageId: string;
  prefixedBody: string;
  waMessageId: string;
}

export interface TakeOverResult extends SentMessage {
  logId: string;
  templateVersion: string;
}

export interface CaseConversationsDeps {
  /** Service role. */
  db: SupabaseClient;
  store: Pick<CaseStore, 'get' | 'role' | 'viewCases'>;
  groups: Pick<SubmissionGroupService, 'sendFromCrm' | 'viewArchive'>;
  handover?: { template: HandoverTemplate; allowDraftTemplate?: boolean };
}

export class CaseConversations {
  constructor(private readonly deps: CaseConversationsDeps) {}

  async read(actor: string, caseId: string): Promise<CaseConversationRead> {
    const { db, store, groups } = this.deps;
    // Audit first: view_case before any message is fetched.
    const readable = await store.viewCases(actor, [caseId]);
    if (!readable.includes(caseId)) return { allowed: false };
    const kase = await store.get(caseId);
    if (!kase) return { allowed: false };
    const group = await loadCaseGroup(db, kase);
    if (!group)
      return { allowed: true, groupId: null, archived: false, messages: [] };
    if (group.status === 'ENDED') {
      const r = await groups.viewArchive({ groupId: group.id, userId: actor });
      return r.allowed
        ? {
            allowed: true,
            groupId: group.id,
            archived: true,
            messages: r.messages,
          }
        : { allowed: false };
    }
    return {
      allowed: true,
      groupId: group.id,
      archived: false,
      messages: await liveGroupMessages(db, group.id),
    };
  }

  async reply(
    actor: string,
    caseId: string,
    text: string
  ): Promise<SentMessage> {
    const { store, groups } = this.deps;
    if (!canWriteCase(await store.role(caseId, actor)))
      throw new CaseRefusedError('NOT_ALLOWED');
    const kase = await store.get(caseId);
    if (!kase) throw new CaseRefusedError('CASE_NOT_FOUND');
    return groups.sendFromCrm({ groupId: kase.groupId, userId: actor, text });
  }

  async takeOver(
    actor: string,
    caseId: string,
    names: { agentName: string; bankName: string }
  ): Promise<TakeOverResult> {
    const { db, store, groups } = this.deps;
    const template = this.deps.handover?.template ?? HANDOVER_TEMPLATE_DRAFT;
    if (
      template.status !== 'APPROVED' &&
      this.deps.handover?.allowDraftTemplate !== true
    )
      throw new CaseTakeOverRefusedError('TEMPLATE_NOT_APPROVED');
    const v = validateHandover(template, names);
    if (!v.ok) throw new CaseTakeOverRefusedError(v.reason);
    // Defence in depth: the route loads the case with { write: true }, and
    // case_takeover_record decides again; this refuses before any write.
    if (!canWriteCase(await store.role(caseId, actor)))
      throw new CaseTakeOverRefusedError('NOT_ALLOWED');
    const kase = await store.get(caseId);
    if (!kase) throw new CaseTakeOverRefusedError('CASE_NOT_FOUND');
    // Record before send: the row stays whatever the send does next.
    const { data, error } = await db.rpc('case_takeover_record', {
      p_actor: actor,
      p_case: caseId,
      p_template_version: v.version,
    });
    if (error) {
      if (typeof error.hint === 'string' && TAKEOVER_HINTS.has(error.hint))
        throw new CaseTakeOverRefusedError(error.hint as TakeOverRefusal);
      throw new CaseStoreError('case_takeover_record', error.code ?? null);
    }
    // A scalar bigint comes back as a number (or a string past 2^53).
    const logId =
      typeof data === 'number' || typeof data === 'string'
        ? String(data)
        : null;
    if (logId === null) throw new CaseStoreError('case_takeover_record', null);
    const sent = await groups.sendFromCrm({
      groupId: kase.groupId,
      userId: actor,
      text: v.text,
    });
    return { logId, templateVersion: v.version, ...sent };
  }
}
