// ============================================================
// Archiving a workspace (migration 105), as the API reads it.
//
// `archive_workspace(p_account_id, p_archive)` does the work and makes
// every decision; this module reads its answer: the result it returns,
// and its refusals as readable errors, each with a stable `code` a
// screen can translate (the English `error` is the fallback).
//
// Pure: no I/O, so it is tested without a database.
// ============================================================

import type { Workspace } from './my-workspaces';
import { canArchiveWorkspace, isAccountRole, type AccountRole } from './roles';

/** What `POST /api/workspaces/archive` answers on success. */
export interface ArchiveResult {
  accountId: string;
  /** The workspace's state now: true archived, false restored. */
  archived: boolean;
  /**
   * The caller's active workspace after the call. An archive moves
   * everyone out, the caller included, so when this differs from the
   * workspace the client was in, it reloads into this one.
   */
  activeAccountId: string | null;
  activeRole: AccountRole | null;
  /** People moved out (0 for a restore, or archiving an archived one). */
  moved: number;
  /** Pending invite links revoked (0 for a restore). */
  invitationsRevoked: number;
}

export type ArchiveErrorCode =
  | 'forbidden'
  | 'no_other_workspace'
  | 'channels_connected'
  | 'calls_routed_here'
  | 'members_stranded';

export interface ArchiveErrorBody {
  error: string;
  code?: ArchiveErrorCode;
  /** members_stranded: how many members have nowhere to go. */
  count?: number;
}

export interface ArchiveFailure {
  status: number;
  body: ArchiveErrorBody;
}

/** The fields of a PostgREST error this module reads. */
export interface RpcError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}

export const NOT_AN_OWNER =
  'Only an owner of that workspace can archive or restore it';

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/** The RPC's jsonb result, or null when it is not one. */
export function parseArchiveResult(raw: unknown): ArchiveResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const moved = count(r.moved);
  const revoked = count(r.invitations_revoked);
  if (
    typeof r.account_id !== 'string' ||
    typeof r.archived !== 'boolean' ||
    moved === null ||
    revoked === null
  ) {
    return null;
  }
  return {
    accountId: r.account_id,
    archived: r.archived,
    activeAccountId:
      typeof r.active_account_id === 'string' ? r.active_account_id : null,
    activeRole: isAccountRole(r.active_role) ? r.active_role : null,
    moved,
    invitationsRevoked: revoked,
  };
}

/** WS003's count: the DETAIL, else the number its message starts with. */
function strandedCount(err: RpcError): number | null {
  for (const text of [err.details, err.message]) {
    const m = typeof text === 'string' ? /^\s*(\d+)/.exec(text) : null;
    if (m) return Number(m[1]);
  }
  return null;
}

/** An `archive_workspace` refusal as the response the route sends. */
export function archiveErrorResponse(
  err: RpcError,
  archive: boolean
): ArchiveFailure {
  switch (err.code) {
    case '42501':
      return { status: 403, body: { error: NOT_AN_OWNER, code: 'forbidden' } };
    case 'WS001':
      return {
        status: 409,
        body: {
          error:
            'You have no other workspace to move to. Create or join another workspace first.',
          code: 'no_other_workspace',
        },
      };
    case 'WS002':
      // Another workspace's phone system still routes numbers or
      // extensions here: the RPC's message names them (DETAIL marks it).
      if (err.details === 'routed_here') {
        return {
          status: 409,
          body: {
            error: err.message
              ? `${err.message}.`
              : "Another workspace's phone system still sends calls here. Remove its numbers and extensions for this workspace first.",
            code: 'calls_routed_here',
          },
        };
      }
      return {
        status: 409,
        body: {
          error:
            'This workspace still has a WhatsApp number or phone system connected. Disconnect its numbers first.',
          code: 'channels_connected',
        },
      };
    case 'WS003': {
      const n = strandedCount(err);
      const who =
        n === null
          ? 'Some members have'
          : n === 1
            ? '1 member has'
            : `${n} members have`;
      return {
        status: 409,
        body: {
          error: `${who} no other workspace to move to. Deactivate or remove them first.`,
          code: 'members_stranded',
          ...(n === null ? {} : { count: n }),
        },
      };
    }
    default:
      return {
        status: 500,
        body: {
          error: archive
            ? 'Could not archive the workspace'
            : 'Could not restore the workspace',
        },
      };
  }
}

// ------------------------------------------------------------
// The screens' side: Settings → Workspace and Settings → Workspaces read
// the route's answers through these.
// ------------------------------------------------------------

/** A key under `Settings.workspace.archive.errors`. */
export type ArchiveMessageKey =
  | 'forbidden'
  | 'no_other_workspace'
  | 'channels_connected'
  | 'calls_routed_here'
  | 'members_stranded'
  | 'members_stranded_unknown'
  | 'failed';

export interface ArchiveMessage {
  key: ArchiveMessageKey;
  /** members_stranded: how many people have nowhere to go. */
  count?: number;
  /**
   * calls_routed_here: the server's own sentence, which names the
   * numbers and extensions still routed here (only the database knows
   * them), shown under the translated message.
   */
  detail?: string;
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * The message for a refused archive or restore, from the route's error
 * body (`{ error, code, count? }`). The `code` decides, never the
 * English `error`; no known code (a 400, a 401, a 500, or no body at
 * all after a network failure) is the generic `failed`.
 */
export function archiveRefusalMessage(body: unknown): ArchiveMessage {
  const b = record(body);
  switch (b.code) {
    case 'forbidden':
      return { key: 'forbidden' };
    case 'no_other_workspace':
      return { key: 'no_other_workspace' };
    case 'channels_connected':
      return { key: 'channels_connected' };
    case 'calls_routed_here': {
      const detail = typeof b.error === 'string' ? b.error.trim() : '';
      return detail
        ? { key: 'calls_routed_here', detail }
        : { key: 'calls_routed_here' };
    }
    case 'members_stranded': {
      const n = count(b.count);
      return n === null
        ? { key: 'members_stranded_unknown' }
        : { key: 'members_stranded', count: n };
    }
    default:
      return { key: 'failed' };
  }
}

/**
 * What the screen does after a successful archive or restore, from the
 * route's 200 body: reload into the workspace the caller now works in
 * when it is not the one on screen (archiving it moved them out),
 * else stay and refresh the workspace list. A body that does not say
 * where the caller is reloads too: the app then lands wherever the
 * server left them.
 */
export function afterArchive(
  body: unknown,
  currentAccountId: string | null
): { reload: true; role: AccountRole | null } | { reload: false } {
  const b = record(body);
  if (
    typeof b.activeAccountId === 'string' &&
    b.activeAccountId === currentAccountId
  ) {
    return { reload: false };
  }
  return {
    reload: true,
    role: isAccountRole(b.activeRole) ? b.activeRole : null,
  };
}

/**
 * Can Settings → Workspaces switch into this workspace? `switch_account` refuses a
 * deactivated membership and an archived workspace, so neither tile
 * switches: both stay listed, marked, with no Switch button.
 */
export function isSwitchableWorkspace(
  w: Pick<Workspace, 'deactivated' | 'archived'>
): boolean {
  return !w.deactivated && !w.archived;
}

/**
 * The archived workspaces Settings → Workspace offers to restore: those
 * where the caller is a live owner, as the route requires.
 * `my_workspaces()` lists an archived workspace to its owners only, but
 * a deactivated owner's row too.
 */
export function restorableWorkspaces(
  workspaces: readonly Workspace[]
): Workspace[] {
  return workspaces.filter(
    (w) =>
      w.archived &&
      !w.deactivated &&
      w.role !== null &&
      canArchiveWorkspace(w.role)
  );
}
