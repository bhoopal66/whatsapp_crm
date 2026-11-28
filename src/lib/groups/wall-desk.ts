/**
 * The group wall's case-desk layer (migration 334), pure: what a column's
 * header, file tags and footer show for a group linked to a bank. The
 * screen translates the keys; the reason words are the ones the desk's
 * group reply uses (`group-intake-text.ts`), pinned by the tests.
 */
import { canLeadTeam, type AccountRole } from '@/lib/auth/roles';
import type { GroupOutcome, GroupWallRow } from '@/lib/desk/group-intake-store';
import { QUEUE_REASON_TEXT, REFUSAL_TEXT } from '@/lib/desk/group-intake-text';
import { deskTabHref } from '@/lib/desk/tabs';

/** The wall's bank figures are refreshed this often while visible. */
export const WALL_BANK_REFRESH_MS = 60_000;

/** A file's outcomes are asked for this long after the column changes. */
export const WALL_OUTCOME_DEBOUNCE_MS = 1_500;

/**
 * A file that just arrived is asked about once more after this long: the
 * intake runs after the message is stored, so the first ask may be early.
 */
export const WALL_OUTCOME_FOLLOW_UP_MS = 10_000;

export type WallTone = 'success' | 'warning' | 'destructive' | 'info';

/** The status-token classes of a tone (always shown with a word). */
export const WALL_TONE_CLASS: Readonly<Record<WallTone, string>> = {
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  destructive: 'bg-destructive-soft text-destructive',
  info: 'bg-info-soft text-info',
};

/** The reason codes the wall has words for; anything else is 'other'. */
export const WALL_QUEUE_REASONS = Object.keys(
  QUEUE_REASON_TEXT
) as readonly (keyof typeof QUEUE_REASON_TEXT)[];
export const WALL_REFUSAL_REASONS = Object.keys(REFUSAL_TEXT);

export type WallFileTag =
  | {
      kind: 'filed';
      tone: 'success';
      caseNumber: string | null;
      docKey: string | null;
    }
  | {
      kind: 'new_case';
      tone: 'info';
      caseNumber: string | null;
      captionCode: string | null;
    }
  | { kind: 'queued'; tone: 'warning'; reason: string }
  | { kind: 'duplicate'; tone: 'info' }
  | { kind: 'refused'; tone: 'destructive'; reason: string }
  | { kind: 'unknown_sender'; tone: 'warning' }
  | { kind: 'no_copy'; tone: 'warning' }
  | { kind: 'file_type'; tone: 'destructive' };

const known = (code: string | null, list: readonly string[]): string =>
  code !== null && list.includes(code) ? code : 'other';

/**
 * The tag under a file of a linked group, or null (a text, or nothing
 * recorded). The item's CURRENT state wins: a queued file a coordinator
 * filed later reads Filed with that case.
 */
export function wallFileTag(o: GroupOutcome | undefined): WallFileTag | null {
  if (!o || o.outcome === 'chat') return null;
  if (o.outcome === 'new_case')
    return {
      kind: 'new_case',
      tone: 'info',
      caseNumber: o.caseNumber,
      captionCode: o.captionCode,
    };
  if (o.itemState === 'filed') return filedTag(o);
  switch (o.outcome) {
    case 'filed':
      return filedTag(o);
    case 'queued':
      return {
        kind: 'queued',
        tone: 'warning',
        reason: known(o.queueReason ?? o.detail, WALL_QUEUE_REASONS),
      };
    case 'duplicate':
      return { kind: 'duplicate', tone: 'info' };
    case 'refused':
      return {
        kind: 'refused',
        tone: 'destructive',
        reason: known(o.detail, WALL_REFUSAL_REASONS),
      };
    case 'unknown_sender':
      return { kind: 'unknown_sender', tone: 'warning' };
    case 'no_copy':
      return { kind: 'no_copy', tone: 'warning' };
    case 'file_type':
      return { kind: 'file_type', tone: 'destructive' };
    default: {
      const unknown: never = o.outcome;
      throw new Error(`Unknown outcome: ${String(unknown)}`);
    }
  }
}

function filedTag(o: GroupOutcome): WallFileTag {
  return {
    kind: 'filed',
    tone: 'success',
    caseNumber: o.caseNumber,
    docKey: o.docKey,
  };
}

/** "wacrm replied" shows only once the reply went out. */
export function wallRepliedNote(o: GroupOutcome | undefined): boolean {
  return o?.replyState === 'sent';
}

/** Hours and zero-padded minutes ("2 h 10"); under an hour, minutes. */
export function wallAge(
  seconds: number | null
): { hours: number; minutes: string } | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return {
    hours,
    minutes: hours > 0 ? String(minutes).padStart(2, '0') : String(minutes),
  };
}

/** The header's queue chip: red with the oldest age when the queue alerts. */
export function wallQueueChip(row: GroupWallRow): {
  count: number;
  alert: boolean;
  age: { hours: number; minutes: string } | null;
} {
  const alert = row.alert === 'second' || row.alert === 'lead';
  return {
    count: row.toSort,
    alert,
    age: alert ? wallAge(row.oldestAgeSeconds) : null,
  };
}

/** The bank has neither a primary nor a second coordinator. */
export function wallNoCoordinator(row: GroupWallRow): boolean {
  return (
    row.alert === 'no_coordinator' ||
    (row.primaryName === null && row.secondName === null)
  );
}

/**
 * The desk's sorting-queue tab. The desk screen reads only `?tab=` (no
 * bank filter), so the link names the tab and the label names the bank.
 */
export const WALL_QUEUE_HREF = deskTabHref('queue');

/** Who may link a group to a bank: team leaders and up (334's rule). */
export function canLinkWallGroup(role: AccountRole | null): boolean {
  if (role === null) return false;
  return canLeadTeam(role);
}

/**
 * The ids of the files a column holds that intake may have recorded
 * (inbound files only), in a stable order, and a key that changes only
 * when that set does.
 */
export function wallOutcomeIds(
  messages: readonly { id: string; direction: string; type: string }[],
  isFile: (m: { type: string }) => boolean
): { ids: string[]; key: string } {
  const ids = messages
    .filter((m) => m.direction === 'in' && isFile(m))
    .map((m) => m.id)
    .sort();
  return { ids, key: ids.join(',') };
}
