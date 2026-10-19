/**
 * Case access mirrors (module 018c). Postgres decides: migration 122's
 * `case_rule_can_read / _write / _reassign` over the live role from
 * `case_role`. These mirror them for the UI only and decide nothing on
 * the server; `access.test.ts` reads 122 and pins them — change one,
 * change both.
 */
import { CASE_ROLES, type CaseRole } from './types';

/** case_rule_can_read: any case role reads. */
export function canReadCase(role: CaseRole | null): boolean {
  return role !== null && CASE_ROLES.includes(role);
}

const WRITERS: readonly CaseRole[] = [
  'super_admin',
  'admin',
  'team_lead',
  'coordinator',
  'agent',
];
/** case_rule_can_write: stage, details, priority, due date, group-end retry. */
export function canWriteCase(role: CaseRole | null): boolean {
  return role !== null && WRITERS.includes(role);
}

const REASSIGNERS: readonly CaseRole[] = ['super_admin', 'admin', 'team_lead'];
/** case_rule_can_reassign: agent or coordinator. */
export function canReassignCase(role: CaseRole | null): boolean {
  return role !== null && REASSIGNERS.includes(role);
}

/** Viewers whose case views `view_case` audits (an agent's are not). */
export const AUDITED_VIEWER_ROLES: readonly CaseRole[] = [
  'coordinator',
  'team_lead',
  'admin',
  'super_admin',
];
