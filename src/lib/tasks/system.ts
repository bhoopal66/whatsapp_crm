/**
 * Service-role helpers for the tasks the system opens and closes: the
 * PBX's missed calls, journey steps, automations (migration 085).
 *
 * `db` is a service-role client. It bypasses RLS, so every read and
 * write here is confined to `accountId` by an explicit filter. Each
 * helper throws on a database error, naming the operation; the caller
 * decides whether a task is worth failing its own work over.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { hasMinRole, isAccountRole } from '@/lib/auth/roles';

import { truncateChars } from './text';
import {
  TASK_NOTE_MAX,
  TASK_TITLE_MAX,
  type SystemTaskInput,
  type SystemTaskSource,
} from './types';

/** The table's UNIQUE (account_id, source, source_ref): the dedupe key. */
const SOURCE_KEY = 'account_id,source,source_ref';

function dbError(
  operation: string,
  error: { code?: string; message?: string }
): Error {
  const code = error.code ? ` (${error.code})` : '';
  return new Error(
    `${operation} failed${code}: ${error.message || 'unknown error'}`
  );
}

/**
 * Open a task for a system event, once per (account, source,
 * sourceRef). A redelivered webhook or a re-run step finds the task
 * already there (`created: false`) instead of opening a second. The
 * insert skips a duplicate (ON CONFLICT DO NOTHING) rather than
 * failing, so two concurrent deliveries also end with one task.
 *
 * Titles are generated, so an overlong one is cut, never refused. A
 * blank title or sourceRef is a caller bug and throws before any write.
 * `created_by` stays null: no person opened the task.
 */
export async function createSystemTask(
  db: SupabaseClient,
  input: SystemTaskInput
): Promise<{ id: string; created: boolean }> {
  if (!input.sourceRef.trim()) {
    throw new Error('createSystemTask: sourceRef is blank');
  }
  const title = truncateChars(input.title.trim(), TASK_TITLE_MAX).trimEnd();
  if (!title) throw new Error('createSystemTask: title is blank');
  const noteText = input.note?.trim();
  const note = noteText
    ? truncateChars(noteText, TASK_NOTE_MAX).trimEnd()
    : null;

  const row = {
    account_id: input.accountId,
    kind: input.kind,
    title,
    note,
    contact_id: input.contactId ?? null,
    conversation_id: input.conversationId ?? null,
    deal_id: input.dealId ?? null,
    assigned_to: input.assignedTo ?? null,
    due_at: input.dueAt ?? null,
    source: input.source,
    source_ref: input.sourceRef,
    meta: input.meta ?? {},
  };

  const { data, error } = await db
    .from('tasks')
    .upsert(row, { onConflict: SOURCE_KEY, ignoreDuplicates: true })
    .select('id');
  if (error) throw dbError('createSystemTask: insert', error);
  const inserted = (data as { id: string }[] | null)?.[0];
  if (inserted) return { id: inserted.id, created: true };

  // Skipped as a duplicate: answer the task that holds the key.
  const { data: existing, error: readError } = await db
    .from('tasks')
    .select('id')
    .eq('account_id', input.accountId)
    .eq('source', input.source)
    .eq('source_ref', input.sourceRef)
    .maybeSingle();
  if (readError) {
    throw dbError('createSystemTask: reading the existing task', readError);
  }
  if (!existing) {
    throw new Error(
      'createSystemTask: the insert was skipped as a duplicate, but no task holds its source_ref'
    );
  }
  return { id: (existing as { id: string }).id, created: false };
}

/**
 * Who a system task goes to: the person the chat is assigned to, else
 * the contact's owner (`contactId`, else the conversation's contact).
 * The first of them who can still hold a task wins: an active member
 * of this account at agent or above, the rule the tasks trigger puts
 * on `assigned_to`. Null leaves the task in the unassigned queue.
 */
export async function resolveTaskOwner(
  db: SupabaseClient,
  accountId: string,
  link: { contactId?: string | null; conversationId?: string | null }
): Promise<string | null> {
  const candidates: string[] = [];
  let contactId = link.contactId ?? null;

  if (link.conversationId) {
    const { data, error } = await db
      .from('conversations')
      .select('assigned_agent_id, contact_id')
      .eq('account_id', accountId)
      .eq('id', link.conversationId)
      .maybeSingle();
    if (error)
      throw dbError('resolveTaskOwner: reading the conversation', error);
    const conversation = data as {
      assigned_agent_id: string | null;
      contact_id: string | null;
    } | null;
    if (conversation?.assigned_agent_id) {
      candidates.push(conversation.assigned_agent_id);
    }
    contactId ??= conversation?.contact_id ?? null;
  }

  if (contactId) {
    const { data, error } = await db
      .from('contacts')
      .select('user_id')
      .eq('account_id', accountId)
      .eq('id', contactId)
      .maybeSingle();
    if (error) throw dbError('resolveTaskOwner: reading the contact', error);
    const owner = (data as { user_id: string | null } | null)?.user_id;
    if (owner) candidates.push(owner);
  }

  if (candidates.length === 0) return null;

  const { data, error } = await db
    .from('profiles')
    .select('user_id, account_role')
    .eq('account_id', accountId)
    .in('user_id', candidates)
    .is('deactivated_at', null);
  if (error) throw dbError('resolveTaskOwner: reading profiles', error);
  const eligible = new Set(
    ((data ?? []) as { user_id: string; account_role: unknown }[])
      .filter(
        (p) =>
          isAccountRole(p.account_role) && hasMinRole(p.account_role, 'agent')
      )
      .map((p) => p.user_id)
  );
  return candidates.find((id) => eligible.has(id)) ?? null;
}

/**
 * Close the open task a system event opened, once the event is dealt
 * with (the call was returned, the journey moved on): status `done`,
 * which the trigger stamps as completed. Only an `open` task moves, so
 * one a person already finished or cancelled stays as they left it.
 * Answers how many closed (at most one: the key is unique).
 */
export async function closeSystemTasks(
  db: SupabaseClient,
  ref: { accountId: string; source: SystemTaskSource; sourceRef: string }
): Promise<number> {
  const { data, error } = await db
    .from('tasks')
    .update({ status: 'done' })
    .eq('account_id', ref.accountId)
    .eq('source', ref.source)
    .eq('source_ref', ref.sourceRef)
    .eq('status', 'open')
    .select('id');
  if (error) throw dbError('closeSystemTasks: update', error);
  return data?.length ?? 0;
}
