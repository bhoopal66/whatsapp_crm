// ============================================================
// Deleting a WhatsApp group for good: the pure half, shared by the
// delete route and the group screens (no server imports).
// ============================================================

import { canDeleteGroups, type AccountRole } from '@/lib/auth/roles';

/** Each still-joined group is a gateway call under `maxDuration` 60. */
export const MAX_JOINED_DELETES = 10;

export interface GroupToDelete {
  id: string;
  channel_id: string | null;
  wa_group_id: string;
  our_role: string;
}

export interface GroupDeletePlan {
  /** Mirrored submission groups: never touched. */
  refused: GroupToDelete[];
  /** `our_role = 'left'`: no gateway call. */
  left: GroupToDelete[];
  /** Not left, but its number is gone: nothing to leave from. */
  orphaned: GroupToDelete[];
  /** Still in the group: leave on WhatsApp first. */
  joined: GroupToDelete[];
  /** Past `MAX_JOINED_DELETES`: not attempted this call. */
  overLimit: GroupToDelete[];
}

export function planGroupDelete(
  rows: readonly GroupToDelete[],
  submissionWaIds: ReadonlySet<string>
): GroupDeletePlan {
  const plan: GroupDeletePlan = {
    refused: [],
    left: [],
    orphaned: [],
    joined: [],
    overLimit: [],
  };
  for (const row of rows) {
    if (submissionWaIds.has(row.wa_group_id)) plan.refused.push(row);
    else if (row.our_role === 'left') plan.left.push(row);
    else if (!row.channel_id) plan.orphaned.push(row);
    else if (plan.joined.length < MAX_JOINED_DELETES) plan.joined.push(row);
    else plan.overLimit.push(row);
  }
  return plan;
}

export interface GroupDeleteOutcome {
  deleted: string[];
  skipped: string[];
  refused: string[];
  failed: Array<{ id: string; reason: string }>;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];

/** The route's answer, read tolerantly (a proxy page, an old server). */
export function parseDeleteOutcome(json: unknown): GroupDeleteOutcome {
  const body = (json ?? {}) as Record<string, unknown>;
  const failed = Array.isArray(body.failed) ? body.failed : [];
  return {
    deleted: strings(body.deleted),
    skipped: strings(body.skipped),
    refused: strings(body.refused),
    failed: failed.flatMap((f: { id?: unknown; reason?: unknown }) =>
      typeof f?.id === 'string' && typeof f?.reason === 'string'
        ? [{ id: f.id, reason: f.reason }]
        : []
    ),
  };
}

/** Who sees "Delete group": owners and admins, never on a submission group. */
export function canDeleteGroup(
  role: AccountRole | null | undefined,
  isSubmissionGroup: boolean
): boolean {
  return !!role && !isSubmissionGroup && canDeleteGroups(role);
}

/** The wording keys (the group screen's namespace) for the delete confirm. */
export function deleteCopyKeys(ourRole: string) {
  return ourRole === 'left'
    ? ({
        title: 'deleteTitle',
        body: 'deleteBody',
        hint: 'deleteHint',
      } as const)
    : ({
        title: 'deleteJoinedTitle',
        body: 'deleteJoinedBody',
        hint: 'deleteJoinedHint',
      } as const);
}

/** Tells the mounted list a group is gone, ahead of its next re-read. */
export const GROUP_DELETED_EVENT = 'wacrm:group-deleted';
