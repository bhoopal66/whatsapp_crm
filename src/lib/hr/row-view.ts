import { stageIndex } from '@/lib/hr/access';
import type { HrListRow } from '@/lib/hr/list-filters';
import type { HrReplyState, HrStage, HrTopic } from '@/lib/hr/types';

/**
 * One tag on an HR-inbox row's HR line, in display order. The row is the
 * normal inbox row (preview, owner, unread count) plus this one line: the
 * stage marker (recruiter) or topic tag (dept) or "Not sorted", then the
 * reply state (or Closed), Urgent and Upset.
 */
export type HrRowTag =
  | { kind: 'stage'; stage: HrStage; reached: number }
  | { kind: 'topic'; topic: HrTopic }
  | { kind: 'noTopic' }
  | { kind: 'notSorted' }
  | { kind: 'reply'; state: HrReplyState }
  | { kind: 'closed' }
  | { kind: 'urgent' }
  | { kind: 'upset' };

export interface HrRowView {
  tags: HrRowTag[];
  /** Department rows wear the Staff ring on the avatar. */
  staffAvatar: boolean;
}

/** What an HR row's HR line shows. `hr` null is "Not sorted". */
export function hrRowView(hr: HrListRow | null | undefined): HrRowView {
  if (!hr) return { tags: [{ kind: 'notSorted' }], staffAvatar: false };
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
  tags.push(
    hr.closed_at !== null
      ? { kind: 'closed' }
      : { kind: 'reply', state: hr.reply_state }
  );
  if (hr.urgent) tags.push({ kind: 'urgent' });
  if (hr.upset) tags.push({ kind: 'upset' });
  return { tags, staffAvatar: hr.inbox === 'dept' };
}
