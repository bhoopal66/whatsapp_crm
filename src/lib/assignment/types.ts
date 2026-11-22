// Shapes of migration 236's assignment functions and settings. Kept
// dependency-free so client components can import them.

/** Why the rotation engine assigned or did not (assignment_rotate_assign). */
export type RotateReason =
  | 'assigned'
  | 'already_assigned'
  | 'engaged'
  | 'personal'
  | 'not_found'
  | 'nobody_eligible'
  /** The call itself failed (network, missing migration). Nothing changed. */
  | 'error';

export interface RotateResult {
  /** The auth user id the chat went to, or null. */
  assignedTo: string | null;
  reason: RotateReason;
  /** Set only when reason is 'error'. */
  error?: string;
}

export type CompassAssignReason =
  | 'off'
  | 'assigned'
  | 'agent_not_eligible'
  | 'already_assigned'
  /** A person is working the chat (human_engaged_at set), as rotation. */
  | 'engaged'
  | 'personal'
  | 'not_found'
  | 'error';

export interface CompassAssignResult {
  /** The account's compass_assign_enabled switch, as the function read it. */
  enabled: boolean;
  assignedTo: string | null;
  reason: CompassAssignReason;
  /** The coordinator a share is open for (new or already there), or null. */
  sharedWith: string | null;
  /** True when this call opened a new share (and rang the coordinator). */
  shareCreated: boolean;
  /** 'shared' | 'already_shared' | 'no_coordinator' | 'coordinator_is_assignee' | 'not_coordinator' */
  shareReason: string | null;
  error?: string;
}

export interface AssignmentSettings {
  broadcastRotationEnabled: boolean;
  /** Auth user ids, in rotation order; empty = all live agents and team leaders. */
  broadcastPool: string[];
  compassAssignEnabled: boolean;
  limitsEnabled: boolean;
  defaultChatLimit: number;
}

/** No settings row = these (migration 236's column defaults). */
export const ASSIGNMENT_SETTINGS_DEFAULTS: AssignmentSettings = {
  broadcastRotationEnabled: false,
  broadcastPool: [],
  compassAssignEnabled: false,
  limitsEnabled: false,
  defaultChatLimit: 30,
};

/** One row of assignment_member_loads(): the Assign menu's "12/30". */
export interface MemberLoad {
  userId: string;
  openCount: number;
  /** Null while chat limits are off. */
  chatLimit: number | null;
}

/** Rotation pool of an automation's assign step. */
export function automationPoolKey(
  automationId: string,
  stepId: string
): string {
  return `automation:${automationId}:${stepId}`;
}

/** Rotation pool of broadcast first replies. */
export const BROADCAST_POOL_KEY = 'broadcast';
