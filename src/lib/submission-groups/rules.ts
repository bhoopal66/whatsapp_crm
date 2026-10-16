/**
 * TEMPORARY STUB (feat/sg-core): the real rules.ts lands with migration 115 on
 * its own branch. Only the names the TS core needs, copied from the package's
 * rules.ts with wacrm role names. Drop this commit at merge.
 */

export type StaffLabel = 'agent' | 'coordinator' | 'team_lead';
export type ArchiveRole = 'owner' | 'admin';
export type GroupStatus = 'ACTIVE' | 'ENDED';

export const DEFAULT_ARCHIVE_SUPERVISOR_WINDOW_DAYS = 60;
export const DEFAULT_FINAL_STATUSES: readonly string[] = [
  'APPROVED',
  'DECLINED',
  'WITHDRAWN',
  'CLOSED',
];

const DAY_MS = 86_400_000;
const norm = (s: string) => s.trim().toUpperCase();

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

export function assertWindowDays(windowDays: number): void {
  if (!Number.isInteger(windowDays) || windowDays < 0)
    throw new RangeError(
      `windowDays must be a non-negative integer, got ${windowDays}`
    );
}
