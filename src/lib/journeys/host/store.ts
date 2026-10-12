/**
 * The journey engine's `JourneyStore` port on Supabase (migration 086).
 * Server-only: it takes the service-role client, because the files, the
 * outbox and the three journey RPCs are the service role's alone.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { newFile } from '../engine';
import type { CommitResult, JourneyStore, OutboxItem } from '../ports';
import type { Action, JourneyFile } from '../types';

/** A supabase-js error from `source` (a table or an RPC), rethrown with its SQLSTATE `code`; the original is `cause`. */
export class JourneyDbError extends Error {
  readonly code: string | undefined;
  constructor(
    readonly source: string,
    error: { message: string; code?: string }
  ) {
    super(
      `${source}: ${error.message}${error.code ? ` (${error.code})` : ''}`,
      {
        cause: error,
      }
    );
    this.name = 'JourneyDbError';
    this.code = error.code || undefined;
  }
}

/**
 * One-row unwrapping of a scalar RPC result. PostgREST answers a function
 * returning a scalar with the bare value, but the same value can also come
 * back as a one-element array, as a one-key object named after the function
 * (`{ fn: value }`), or as both (`[{ fn: value }]`). Any other shape is
 * returned as it is, for the caller's own check to reject.
 */
export function rpcScalar(fn: string, data: unknown): unknown {
  let value = Array.isArray(data) && data.length === 1 ? data[0] : data;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === fn)
      value = (value as Record<string, unknown>)[fn];
  }
  return value;
}

interface OutboxRow {
  id: string;
  file_id: string;
  seq: number;
  action: Action;
  status: OutboxItem['status'];
  drop_reason: string | null;
}

const COMMIT_RESULTS: readonly unknown[] = ['ok', 'duplicate', 'conflict'];

export class SupabaseJourneyStore implements JourneyStore {
  constructor(private readonly db: SupabaseClient) {}

  async load(fileId: string): Promise<JourneyFile | null> {
    const { data, error } = await this.db
      .from('journey_files')
      .select('body, version')
      .eq('id', fileId)
      .maybeSingle();
    if (error) throw new JourneyDbError('journey_files', error);
    if (!data) return null;
    const row = data as { body: JourneyFile; version: number };
    // The column is what journey_commit compares, so it is the version.
    return { ...row.body, version: row.version };
  }

  async commit(
    expectedVersion: number,
    fileAfter: JourneyFile,
    eventId: string,
    actions: Action[]
  ): Promise<CommitResult> {
    const { data, error } = await this.db.rpc('journey_commit', {
      p_file_id: fileAfter.id,
      p_expected_version: expectedVersion,
      p_file: fileAfter,
      p_event_id: eventId,
      p_actions: actions,
    });
    if (error) throw new JourneyDbError('journey_commit', error);
    const result = rpcScalar('journey_commit', data);
    if (COMMIT_RESULTS.includes(result)) return result as CommitResult;
    throw new Error(
      `journey_commit: unexpected result ${JSON.stringify(data)} for file ${fileAfter.id}`
    );
  }

  async pendingOutbox(fileId: string): Promise<OutboxItem[]> {
    const { data, error } = await this.db
      .from('journey_outbox')
      .select('id, file_id, seq, action, status, drop_reason')
      .eq('file_id', fileId)
      .eq('status', 'pending');
    if (error) throw new JourneyDbError('journey_outbox', error);
    return ((data ?? []) as OutboxRow[]).map((row) => ({
      id: row.id,
      fileId: row.file_id,
      seq: row.seq,
      action: row.action,
      status: row.status,
      ...(row.drop_reason != null ? { dropReason: row.drop_reason } : {}),
    }));
  }

  /** Only a pending item moves: a delivered or dropped one keeps its outcome. */
  async markDelivered(itemId: string): Promise<void> {
    const { error } = await this.db
      .from('journey_outbox')
      .update({ status: 'delivered', delivered_at: new Date().toISOString() })
      .eq('id', itemId)
      .eq('status', 'pending');
    if (error) throw new JourneyDbError('journey_outbox', error);
  }

  async markDropped(itemId: string, reason: string): Promise<void> {
    const { error } = await this.db
      .from('journey_outbox')
      .update({ status: 'dropped', drop_reason: reason })
      .eq('id', itemId)
      .eq('status', 'pending');
    if (error) throw new JourneyDbError('journey_outbox', error);
  }

  async pendingOptOut(contactId: string): Promise<boolean | null> {
    const { data, error } = await this.db.rpc('journey_pending_opt_out', {
      p_contact_id: contactId,
    });
    if (error) throw new JourneyDbError('journey_pending_opt_out', error);
    const value = rpcScalar('journey_pending_opt_out', data);
    if (value === null || typeof value === 'boolean') return value;
    throw new Error(
      `journey_pending_opt_out: unexpected result ${JSON.stringify(data)}`
    );
  }
}

/** Whose journey `ensureOpenFile` finds or opens. */
export interface OpenFileInit {
  accountId: string;
  contactId: string;
  conversationId?: string | null;
  workflowKey: string;
}

async function openFileId(
  db: SupabaseClient,
  { accountId, contactId }: OpenFileInit
): Promise<string | null> {
  const { data, error } = await db
    .from('journey_files')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .is('closed_at', null)
    .maybeSingle();
  if (error) throw new JourneyDbError('journey_files', error);
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * The id of the contact's open journey file, creating one (the engine's
 * `newFile`, version 0) when there is none. At most one file per contact is
 * open (`journey_files_one_open`), so the loser of a creation race gets
 * 23505 and answers with the winner's id.
 */
export async function ensureOpenFile(
  db: SupabaseClient,
  init: OpenFileInit
): Promise<string> {
  const open = await openFileId(db, init);
  if (open) return open;
  const file = newFile({
    id: crypto.randomUUID(),
    contactId: init.contactId,
    workspaceId: init.accountId,
  });
  const { error } = await db.from('journey_files').insert({
    id: file.id,
    account_id: init.accountId,
    contact_id: init.contactId,
    conversation_id: init.conversationId ?? null,
    workflow_key: init.workflowKey,
    product: null,
    entry: null,
    state: file.state,
    body: file,
    version: 0,
  });
  if (!error) return file.id;
  if (error.code === '23505') {
    const winner = await openFileId(db, init);
    if (winner) return winner;
  }
  throw new JourneyDbError('journey_files', error);
}
