// ============================================================
// Compass assignment (migration 236, item 5): after a Compass status
// update reaches a customer's 1:1 chat, a chat nobody holds goes to the
// case's agent and is shared with the case's coordinator — only while
// the account's `compass_assign_enabled` switch is on. Off, the only
// thing that happens is the settings read: no case lookup, no write.
//
// Which case. A notification carries no case id; Compass sends its
// submission id as `reference` (the same field the submission-group
// routing reads, 170). So:
//   1. `reference` names a submission group (submission_groups.
//      submission_ref) and that group's case (cases.group_id) is the
//      case, when its customer is this chat's contact;
//   2. otherwise the contact's ONE open case (closed_at IS NULL), found
//      by cases.contact_id (leads, desk cases) or through the contact's
//      submission groups. Several open cases are ambiguous: nothing is
//      assigned rather than guessing.
// The case's agent is cases.agent_id, its coordinator cases.coordinator_id
// (both auth user ids), and the share's bank is cases.bank_code. The SQL
// re-checks everything (live staff, a coordinator of that bank, the chat
// still unassigned) under the account lock.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { compassAssign, loadAssignmentSettings } from './rotation';
import type { CompassAssignResult } from './types';

export interface CompassCase {
  id: string;
  agentId: string | null;
  coordinatorId: string | null;
  bankCode: string | null;
}

const CASE_COLUMNS =
  'id, agent_id, coordinator_id, bank_code, contact_id, group_id';

interface CaseRow {
  id: string;
  agent_id: string | null;
  coordinator_id: string | null;
  bank_code: string | null;
  contact_id: string | null;
  group_id: string | null;
}

const toCase = (row: CaseRow): CompassCase => ({
  id: row.id,
  agentId: row.agent_id ?? null,
  coordinatorId: row.coordinator_id ?? null,
  bankCode: row.bank_code ?? null,
});

/**
 * The case a Compass update is about (see the header). Null when none
 * or several match. Throws on a read error; `assignFromCompassCase`
 * catches.
 */
export async function findCompassCase(
  db: SupabaseClient,
  accountId: string,
  input: { reference: string | null; contactId: string | null }
): Promise<CompassCase | null> {
  if (input.reference) {
    const { data: group, error } = await db
      .from('submission_groups')
      .select('id, contact_id')
      .eq('account_id', accountId)
      .eq('submission_ref', input.reference)
      .maybeSingle();
    if (error)
      throw new Error(`submission group read failed: ${error.message}`);
    const g = group as { id: string; contact_id: string | null } | null;
    if (g) {
      const { data: row, error: caseError } = await db
        .from('cases')
        .select(CASE_COLUMNS)
        .eq('account_id', accountId)
        .eq('group_id', g.id)
        .maybeSingle();
      if (caseError) throw new Error(`case read failed: ${caseError.message}`);
      const c = row as CaseRow | null;
      const customer = c?.contact_id ?? g.contact_id;
      if (
        c &&
        (!input.contactId || !customer || customer === input.contactId)
      ) {
        return toCase(c);
      }
    }
  }

  if (!input.contactId) return null;

  const { data: direct, error: directError } = await db
    .from('cases')
    .select(CASE_COLUMNS)
    .eq('account_id', accountId)
    .eq('contact_id', input.contactId)
    .is('closed_at', null);
  if (directError) throw new Error(`case read failed: ${directError.message}`);

  const { data: groups, error: groupsError } = await db
    .from('submission_groups')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', input.contactId);
  if (groupsError) {
    throw new Error(`submission group read failed: ${groupsError.message}`);
  }
  const groupIds = ((groups ?? []) as { id: string }[]).map((g) => g.id);
  let viaGroups: CaseRow[] = [];
  if (groupIds.length > 0) {
    const { data, error } = await db
      .from('cases')
      .select(CASE_COLUMNS)
      .eq('account_id', accountId)
      .in('group_id', groupIds)
      .is('closed_at', null);
    if (error) throw new Error(`case read failed: ${error.message}`);
    viaGroups = (data ?? []) as CaseRow[];
  }

  const open = new Map<string, CaseRow>();
  for (const row of [...((direct ?? []) as CaseRow[]), ...viaGroups]) {
    open.set(row.id, row);
  }
  return open.size === 1 ? toCase([...open.values()][0]) : null;
}

export type CompassCaseAssignOutcome =
  | { status: 'off' }
  | { status: 'no_case' }
  | { status: 'done'; caseId: string; result: CompassAssignResult }
  | { status: 'error'; error: string };

/**
 * Assign a chat a Compass update was just sent into to its case's agent
 * and share it with the case's coordinator, when the switch is on.
 * Never throws.
 */
export async function assignFromCompassCase(
  db: SupabaseClient,
  accountId: string,
  input: {
    conversationId: string;
    contactId: string | null;
    reference: string | null;
  }
): Promise<CompassCaseAssignOutcome> {
  try {
    const settings = await loadAssignmentSettings(db, accountId);
    if (!settings.compassAssignEnabled) return { status: 'off' };

    const found = await findCompassCase(db, accountId, {
      reference: input.reference,
      contactId: input.contactId,
    });
    if (!found) return { status: 'no_case' };

    const result = await compassAssign(db, {
      accountId,
      conversationId: input.conversationId,
      agentUserId: found.agentId,
      coordinatorUserId: found.coordinatorId,
      bankCode: found.bankCode,
    });
    if (result.reason === 'error') {
      console.error('[compass/notify] assignment failed:', result.error);
    }
    return { status: 'done', caseId: found.id, result };
  } catch (err) {
    console.error('[compass/notify] assignment failed:', err);
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
