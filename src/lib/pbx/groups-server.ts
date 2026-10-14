import type { SupabaseClient } from '@supabase/supabase-js';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { pbxServiceDb } from './admin';
import { myExtension } from './calls';
import { PbxConnectionError, connectionForAccount } from './connection';

// The server side of the ring group and queue screens (Linkus's
// Groups and Queues tabs): which PBX the caller works on, and which of
// its extensions belong to the caller's workspace. Shared by
// GET /api/pbx/groups and POST /api/pbx/queues/[id]/agent.

/** The PBX the caller works on, and their own extension on it. */
export interface GroupsConnection {
  connectionId: string;
  myExtension: string | null;
}

/**
 * The caller's own extension's connection; a team leader or above with
 * no extension falls back to the workspace's PBX. Null for anyone below
 * team leader with no extension (the routes answer noExtension()). A
 * leader whose workspace reaches no PBX is a PbxConnectionError, which
 * pbxFailure() words.
 */
export async function groupsConnection(ctx: {
  supabase: SupabaseClient;
  accountId: string;
  role: AccountRole;
}): Promise<GroupsConnection | null> {
  const ext = await myExtension(ctx.supabase);
  if (ext)
    return { connectionId: ext.connectionId, myExtension: ext.extension };
  if (!hasMinRole(ctx.role, 'team_leader')) return null;
  const connectionId = await connectionForAccount(
    pbxServiceDb(),
    ctx.accountId
  );
  if (!connectionId)
    throw new PbxConnectionError(
      'not_found',
      `no PBX connection reaches account ${ctx.accountId}`
    );
  return { connectionId, myExtension: null };
}

export interface MappedPerson {
  userId: string;
  name: string | null;
}

/**
 * The connection's extensions mapped to a person in the caller's
 * workspace, by extension number. Read on the caller's client, so RLS
 * keeps it to the active workspace: on a PBX shared between workspaces
 * another workspace's extensions are simply absent.
 */
export async function workspaceExtensions(
  rls: SupabaseClient,
  accountId: string,
  connectionId: string
): Promise<Map<string, MappedPerson>> {
  const { data, error } = await rls
    .from('pbx_extensions')
    .select('extension, user_id')
    .eq('connection_id', connectionId)
    .not('user_id', 'is', null);
  if (error) throw new Error(`pbx_extensions read failed: ${error.message}`);
  const rows = (
    (data ?? []) as { extension: string; user_id: string | null }[]
  ).filter((r): r is { extension: string; user_id: string } => !!r.user_id);
  const out = new Map<string, MappedPerson>();
  if (!rows.length) return out;

  const { data: people, error: peopleError } = await rls
    .from('profiles')
    .select('user_id, full_name')
    .eq('account_id', accountId)
    .in('user_id', [...new Set(rows.map((r) => r.user_id))]);
  if (peopleError)
    throw new Error(`profiles read failed: ${peopleError.message}`);
  const names = new Map(
    ((people ?? []) as { user_id: string; full_name: string | null }[]).map(
      (p) => [p.user_id, p.full_name?.trim() || null]
    )
  );
  for (const r of rows)
    out.set(r.extension, {
      userId: r.user_id,
      name: names.get(r.user_id) ?? null,
    });
  return out;
}

export const QUEUE_CALL_STATUSES = [
  'unknown',
  'idle',
  'in_call',
  'ringing',
  'waiting',
  'on_hold',
] as const;
export type QueueCallStatus = (typeof QUEUE_CALL_STATUSES)[number];

/** queue/agent_status's call_status (0–5); anything else is unknown. */
export const queueCallStatus = (n: number): QueueCallStatus =>
  QUEUE_CALL_STATUSES[n] ?? 'unknown';

/** `fn` over `items`, at most `limit` at a time, results in input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return out;
}
