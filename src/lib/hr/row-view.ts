import { stageIndex } from '@/lib/hr/access';
import type { HrListRow } from '@/lib/hr/list-filters';
import type { HrReplyState, HrStage, HrTopic } from '@/lib/hr/types';

/**
 * One tag on an HR-inbox row's tag line, in display order. The package's
 * row (release 023d): the stage marker (recruiter) or topic tag (dept) or
 * "Not sorted", then the reply state (or Closed), Urgent, and Unread
 * while a reply is due. The owner's name sits apart, at the right.
 */
export type HrRowTag =
  | { kind: 'stage'; stage: HrStage; reached: number }
  | { kind: 'topic'; topic: HrTopic }
  | { kind: 'noTopic' }
  | { kind: 'notSorted' }
  | { kind: 'reply'; state: HrReplyState }
  | { kind: 'closed' }
  | { kind: 'urgent' }
  | { kind: 'unread' };

export interface HrRowView {
  tags: HrRowTag[];
  /** Department rows wear the Staff avatar variant. */
  staffAvatar: boolean;
  /** The owner's first name, or null for "Unassigned". */
  ownerFirstName: string | null;
}

/** First word of a display name; null when there is none. */
export function firstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}

/** Up to two initials (letters or digits), upper-cased. */
export function initialsOf(name: string): string {
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  if (words.length === 0) return '?';
  const picked =
    words.length === 1 ? [words[0]] : [words[0], words[words.length - 1]];
  return picked
    .map((w) => Array.from(w)[0])
    .join('')
    .toLocaleUpperCase();
}

/**
 * What an HR row shows. `hr` null is a chat with no HR row yet ("Not
 * sorted"); `ownerName` is the assignee's display name, null when none.
 */
export function hrRowView(
  hr: HrListRow | null | undefined,
  ownerName: string | null
): HrRowView {
  const ownerFirstName = firstName(ownerName);
  if (!hr) {
    return {
      tags: [{ kind: 'notSorted' }],
      staffAvatar: false,
      ownerFirstName,
    };
  }
  const tags: HrRowTag[] = [];
  if (hr.inbox === 'recruiter') {
    const reached = stageIndex(hr.stage_key);
    if (hr.stage_key && reached >= 0) {
      tags.push({ kind: 'stage', stage: hr.stage_key as HrStage, reached });
    }
  } else {
    tags.push(
      hr.topic ? { kind: 'topic', topic: hr.topic } : { kind: 'noTopic' }
    );
  }
  const closed = hr.closed_at !== null;
  tags.push(
    closed ? { kind: 'closed' } : { kind: 'reply', state: hr.reply_state }
  );
  if (hr.urgent) tags.push({ kind: 'urgent' });
  if (!closed && hr.reply_state === 'reply_due') tags.push({ kind: 'unread' });
  return { tags, staffAvatar: hr.inbox === 'dept', ownerFirstName };
}
