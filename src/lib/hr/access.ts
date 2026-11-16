/**
 * Pure mirrors of migration 200's permission rules. They decide only
 * what the HR screens offer; every RPC re-checks, and every action
 * also needs the chat to be visible to the caller (today's rules), which
 * these helpers cannot see. Change one, change both.
 */
import { HR_STAGES, type HrInbox, type HrRole, type HrRoles } from './types';

/** `hr_role()`: admin wins over any team row. */
export function hrRoleFor(roles: HrRoles, inbox: HrInbox): HrRole | null {
  if (roles.admin) return 'admin';
  return roles[inbox];
}

/** Any HR role at all: admin, or a lead/member of either inbox. */
export function hasHrAccess(roles: HrRoles): boolean {
  return roles.admin || roles.recruiter !== null || roles.dept !== null;
}

/** Stage, topic, flag, open and close writes on a chat in `inbox`. */
export function canWrite(roles: HrRoles, inbox: HrInbox): boolean {
  return hrRoleFor(roles, inbox) !== null;
}

const leads = (roles: HrRoles, inbox: HrInbox): boolean => {
  const role = hrRoleFor(roles, inbox);
  return role === 'admin' || role === 'lead';
};

/** 0-based position of a recruitment stage; -1 for unknown or missing. */
export function stageIndex(stage: string | null | undefined): number {
  return stage == null ? -1 : (HR_STAGES as readonly string[]).indexOf(stage);
}

/**
 * Whether setting `targetStage` is a backward move (`hr_set_stage`).
 * Within the recruiter inbox it is backward when the target sits before
 * the current stage. Coming back from the dept inbox it is backward when
 * the target sits before the furthest stage the chat ever reached (the
 * 023b loophole: otherwise a member could step back by bouncing through
 * dept). A first entry, or one at or after the furthest, is forward.
 */
export function isBackwardMove(
  currentInbox: HrInbox,
  currentStage: string | null,
  targetStage: string,
  furthestStage: string | null
): boolean {
  const target = stageIndex(targetStage);
  if (target < 0) return false;
  const reference =
    currentInbox === 'recruiter'
      ? stageIndex(currentStage)
      : stageIndex(furthestStage);
  return reference >= 0 && target < reference;
}

/** A backward stage move: recruiter lead or admin (plus a reason). */
export function canMoveBackward(roles: HrRoles): boolean {
  return leads(roles, 'recruiter');
}

/** Reopening a closed HR chat: lead of that inbox or admin (plus a reason). */
export function canReopen(roles: HrRoles, inbox: HrInbox): boolean {
  return leads(roles, inbox);
}

/** `hr_rule_set`: lead of the rule's inbox or admin. */
export function canEditRule(roles: HrRoles, ruleInbox: HrInbox): boolean {
  return leads(roles, ruleInbox);
}

/** `hr_member_set`: the account's owners and admins only. */
export function canManageTeam(roles: HrRoles): boolean {
  return roles.admin;
}

/** Which inbox a write lands the chat in: a stage means recruitment. */
export function moveTarget(action: 'stage' | 'topic'): HrInbox {
  return action === 'stage' ? 'recruiter' : 'dept';
}
