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

import { isAccountRole, type AccountRole } from './roles';

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
