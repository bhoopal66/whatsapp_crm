/**
 * Submission Group rules (pure; module 018a). One WhatsApp group per
 * submitted case, hosted by one Whapi number; staff reach it through a
 * per-group access list and write from the CRM, every outgoing message
 * prefixed with the sender's name and label.
 *
 * Mirrors sg_rule_can_read / sg_can_send in migration 115 — change one,
 * change both:
 *   ACTIVE: read ⇔ owner/admin of the account, or on the open access list
 *           with a staff label. Send ⇔ on the open list (admins too only
 *           when they are on it).
 *   ENDED : read ⇔ owner/admin, or a coordinator / team_lead who was on the
 *           list at the end with that label, while
 *           now < endedAt + windowDays × 24 h (default 60). Agents never.
 *           Only through the audited sg_read_archive. Nobody sends.
 * A group ends when its submission reaches a final status, or (if idleDays
 * is set) after idleDays without activity.
 */

export type StaffLabel = 'agent' | 'coordinator' | 'team_lead';
export type ArchiveRole = 'owner' | 'admin';
/** A role as SQL resolves it for one user and group: the account role for owner/admin, else the access label. */
export type GroupRole = StaffLabel | ArchiveRole;
export type GroupStatus = 'ACTIVE' | 'ENDED';

export const STAFF_LABELS: readonly StaffLabel[] = [
  'agent',
  'coordinator',
  'team_lead',
];
export const ARCHIVE_ROLES: readonly ArchiveRole[] = ['owner', 'admin'];
/** Labels that keep reading an ENDED group during the supervisor window. */
export const SUPERVISOR_LABELS: readonly StaffLabel[] = [
  'coordinator',
  'team_lead',
];
/** The text in the message prefix, "Name (Label): text". */
export const ROLE_LABELS: Record<StaffLabel, string> = {
  agent: 'Agent',
  coordinator: 'Coordinator',
  team_lead: 'Team Lead',
};

/** Days after ended_at during which the group's coordinator / team_lead may still read it. */
export const DEFAULT_ARCHIVE_SUPERVISOR_WINDOW_DAYS = 60;
export const DEFAULT_FINAL_STATUSES: readonly string[] = [
  'APPROVED',
  'DECLINED',
  'WITHDRAWN',
  'CLOSED',
];

const DAY_MS = 86_400_000;
const norm = (s: string) => s.trim().toUpperCase();

export function isStaffLabel(value: unknown): value is StaffLabel {
  return (STAFF_LABELS as readonly unknown[]).includes(value);
}

export function isFinalStatus(
  status: string,
  finalList: readonly string[] = DEFAULT_FINAL_STATUSES
): boolean {
  const s = norm(status);
  return finalList.some((f) => norm(f) === s);
}

export type EndDecision = { end: false } | { end: true; reason: string };

/** FINAL_STATUS:<status> wins over IDLE. idleDays null = idle ending off. */
export function shouldEnd(input: {
  status: string;
  lastActivityAt: Date;
  idleDays: number | null;
  now: Date;
  finalList?: readonly string[];
}): EndDecision {
  if (isFinalStatus(input.status, input.finalList))
    return { end: true, reason: `FINAL_STATUS:${norm(input.status)}` };
  if (input.idleDays !== null) {
    if (!Number.isInteger(input.idleDays) || input.idleDays < 1)
      throw new RangeError(
        `idleDays must be a positive integer or null, got ${input.idleDays}`
      );
    if (
      input.now.getTime() - input.lastActivityAt.getTime() >=
      input.idleDays * DAY_MS
    )
      return { end: true, reason: 'IDLE' };
  }
  return { end: false };
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** "Ali (Agent): text". Name and label are collapsed to one line so a name cannot fake a second message. */
export function prefixMessage(
  displayName: string,
  roleLabel: string,
  text: string
): string {
  const name = oneLine(displayName);
  const label = oneLine(roleLabel);
  if (name === '') throw new RangeError('prefixMessage: displayName is empty');
  return label === '' ? `${name}: ${text}` : `${name} (${label}): ${text}`;
}

/** Configuration check (the service's constructor). canRead itself treats a negative window as closed, as SQL does. */
export function assertWindowDays(windowDays: number): void {
  if (!Number.isInteger(windowDays) || windowDays < 0)
    throw new RangeError(
      `windowDays must be a non-negative integer, got ${windowDays}`
    );
}

/**
 * ENDED-group inputs for the supervisor window, as SQL derives them:
 * onListAtEnd = an access row for this user with THIS label, added by
 * endedAt and not removed before it. Omitted: only owner/admin read.
 */
export interface EndedReadInput {
  onListAtEnd: boolean;
  endedAt: Date;
  now: Date;
  windowDays?: number;
}

/**
 * Mirrors sg_rule_can_read / sg_visible_ids. `onList` means on the open
 * list AND live staff (agent and up): SQL's sg_is_staff, so a member
 * demoted to viewer or deactivated after being listed is not onList.
 */
export function canRead(
  role: GroupRole | null,
  status: GroupStatus,
  onList: boolean,
  ended?: EndedReadInput
): boolean {
  if (role === null) return false;
  const archive = (ARCHIVE_ROLES as readonly string[]).includes(role);
  if (status === 'ACTIVE') return archive || (onList && isStaffLabel(role));
  if (status === 'ENDED') {
    if (archive) return true;
    if (!ended || !ended.onListAtEnd) return false;
    if (!(SUPERVISOR_LABELS as readonly string[]).includes(role)) return false;
    const windowDays =
      ended.windowDays ?? DEFAULT_ARCHIVE_SUPERVISOR_WINDOW_DAYS;
    if (!(windowDays >= 0)) return false;
    return ended.now.getTime() < ended.endedAt.getTime() + windowDays * DAY_MS;
  }
  return false;
}

/** On the open list with a staff label (an owner/admin sends only when listed). */
export function canSend(
  label: StaffLabel | null,
  status: GroupStatus,
  onList: boolean
): boolean {
  return status === 'ACTIVE' && onList && label !== null && isStaffLabel(label);
}
