/**
 * The Groups list as one list: the account's WhatsApp groups and the
 * caller's ACTIVE submission groups, latest activity first. Pure, so the
 * route's two rules are tested without a database:
 *
 * - A submission group is shown as itself, never through a mirror row.
 *   Past Syncs copied some into `whatsapp_groups`; a row whose WhatsApp
 *   id belongs to any submission group of the account is dropped, whether
 *   or not the caller may read that submission group.
 * - `wa_group_id` stays on the server: items are built field by field.
 */
import { customerNotInGroup } from '@/lib/submission-groups/ui';

import type { WhatsappGroupRow } from './types';
import { byActivity, type GroupListItem } from './ui';

/** The `submission_groups` columns a list row needs, and no more. */
export const SUBMISSION_ROW_COLUMNS =
  'id, channel_id, subject, customer_name, submission_ref, wa_group_id, last_activity_at, customer_membership';

export interface SubmissionListRow {
  id: string;
  channel_id: string | null;
  subject: string | null;
  customer_name: string | null;
  submission_ref: string;
  wa_group_id: string | null;
  last_activity_at: string | null;
  /** 174: absent on older fixtures, which read as 'unknown'. */
  customer_membership?: 'unknown' | 'joined' | 'absent';
}

export interface MergeGroupListInput {
  groups: readonly WhatsappGroupRow[];
  submissionRows: readonly SubmissionListRow[];
  /** Every submission group's WhatsApp id in the account. */
  mirrorWaIds: ReadonlySet<string>;
  unread: ReadonlyMap<string, number>;
  canManage: ReadonlySet<string>;
  channelOf: ReadonlyMap<string, NonNullable<GroupListItem['channel']>>;
}

/** The WhatsApp subject, else the customer, else the submission's ref. */
export function submissionRowName(row: SubmissionListRow): string {
  return row.subject?.trim() || row.customer_name?.trim() || row.submission_ref;
}

export function mergeGroupList(input: MergeGroupListInput): GroupListItem[] {
  const { submissionRows, unread, canManage, channelOf } = input;
  // The caller's own rows count too: if the account-wide read failed,
  // a group they can see must still not be listed twice.
  const mirrors = new Set(input.mirrorWaIds);
  for (const row of submissionRows) {
    if (row.wa_group_id) mirrors.add(row.wa_group_id);
  }

  const channel = (id: string | null) => (id && channelOf.get(id)) || null;
  const normal = input.groups
    .filter((g) => !mirrors.has(g.wa_group_id))
    .map((g): GroupListItem => ({
      id: g.id,
      kind: 'group',
      name: g.name,
      description: g.description,
      icon_url: g.icon_url,
      participants_count: g.participants_count,
      our_role: g.our_role,
      channel_id: g.channel_id,
      channel: channel(g.channel_id),
      last_message_at: g.last_message_at,
      created_by: g.created_by,
      can_manage: canManage.has(g.id),
      unread: 0,
    }));
  const submission = submissionRows.map((row): GroupListItem => ({
    id: row.id,
    kind: 'submission',
    name: submissionRowName(row),
    // Not displayed: it is what the list's own search reads, so a
    // customer's name finds the row when the subject does not hold it.
    description: row.customer_name,
    icon_url: null,
    // Not stored for these groups; the row leaves the count out.
    participants_count: 0,
    our_role: 'member',
    channel_id: row.channel_id,
    channel: channel(row.channel_id),
    last_message_at: row.last_activity_at,
    created_by: null,
    can_manage: false,
    unread: unread.get(row.id) ?? 0,
    // The route lists ACTIVE rows of WhatsApp groups only.
    customer_absent: customerNotInGroup({
      status: 'ACTIVE',
      wa_mode: 'group',
      customer_membership: row.customer_membership,
    }),
  }));

  return [...normal, ...submission].sort(byActivity);
}
