import { describe, expect, it } from 'vitest';

import {
  mergeGroupList,
  submissionRowName,
  type MergeGroupListInput,
  type SubmissionListRow,
} from './merge-list';
import type { WhatsappGroupRow } from './types';

const group = (over: Partial<WhatsappGroupRow>) =>
  ({
    id: 'g1',
    channel_id: 'c1',
    wa_group_id: 'wa-g1',
    name: 'Team',
    description: null,
    icon_url: null,
    participants_count: 4,
    our_role: 'admin',
    created_by: 'u1',
    last_message_at: '2026-11-02T10:00:00Z',
    ...over,
  }) as WhatsappGroupRow;

const submission = (
  over: Partial<SubmissionListRow> = {}
): SubmissionListRow => ({
  id: 's1',
  channel_id: 'c1',
  subject: 'Acme x Taamul Credit',
  customer_name: 'Acme LLC',
  submission_ref: 'SUB-1',
  wa_group_id: 'wa-s1',
  last_activity_at: '2026-11-03T10:00:00Z',
  ...over,
});

const merge = (over: Partial<MergeGroupListInput>) =>
  mergeGroupList({
    groups: [],
    submissionRows: [],
    mirrorWaIds: new Set(),
    unread: new Map(),
    canManage: new Set(),
    channelOf: new Map([['c1', { id: 'c1', name: 'Sales', phone: '971' }]]),
    ...over,
  });

describe('mergeGroupList', () => {
  it('drops a mirror of a submission group the caller cannot see', () => {
    const list = merge({
      groups: [group({}), group({ id: 'mirror', wa_group_id: 'wa-hidden' })],
      mirrorWaIds: new Set(['wa-hidden']),
    });
    expect(list.map((g) => g.id)).toEqual(['g1']);
  });

  it('lists a group once when the account-wide id read came back empty', () => {
    const list = merge({
      groups: [group({ id: 'mirror', wa_group_id: 'wa-s1' })],
      submissionRows: [submission()],
    });
    expect(list.map((g) => g.id)).toEqual(['s1']);
  });

  it('marks each kind and orders by activity, undated rows last', () => {
    const list = merge({
      groups: [
        group({ id: 'old', last_message_at: '2026-11-01T10:00:00Z' }),
        group({ id: 'new', last_message_at: '2026-11-04T10:00:00Z' }),
        group({ id: 'idle', last_message_at: null }),
      ],
      submissionRows: [submission()],
      canManage: new Set(['new']),
    });
    expect(list.map((g) => [g.id, g.kind])).toEqual([
      ['new', 'group'],
      ['s1', 'submission'],
      ['old', 'group'],
      ['idle', 'group'],
    ]);
    expect(list[0]).toMatchObject({ can_manage: true, unread: 0 });
  });

  it('builds a submission row that cannot be managed or deleted', () => {
    const [item] = merge({
      submissionRows: [submission()],
      unread: new Map([['s1', 3]]),
      canManage: new Set(['s1']),
    });
    expect(item).toEqual({
      id: 's1',
      kind: 'submission',
      name: 'Acme x Taamul Credit',
      description: 'Acme LLC',
      icon_url: null,
      participants_count: 0,
      our_role: 'member',
      channel_id: 'c1',
      channel: { id: 'c1', name: 'Sales', phone: '971' },
      last_message_at: '2026-11-03T10:00:00Z',
      created_by: null,
      can_manage: false,
      unread: 3,
    });
  });

  it('never carries a WhatsApp id to the client', () => {
    const json = JSON.stringify(
      merge({ groups: [group({})], submissionRows: [submission()] })
    );
    expect(json).not.toContain('wa-');
  });
});

describe('submissionRowName', () => {
  it('takes the subject, then the customer, then the ref', () => {
    expect(submissionRowName(submission())).toBe('Acme x Taamul Credit');
    expect(submissionRowName(submission({ subject: '  ' }))).toBe('Acme LLC');
    expect(
      submissionRowName(submission({ subject: null, customer_name: null }))
    ).toBe('SUB-1');
  });
});
