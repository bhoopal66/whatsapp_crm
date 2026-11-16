import { describe, expect, it } from 'vitest';

import type { HrListRow } from '@/lib/hr/list-filters';

import { firstName, hrRowView, initialsOf } from './row-view';

function hr(over: Partial<HrListRow> = {}): HrListRow {
  return {
    inbox: 'recruiter',
    stage_key: 'cv_review',
    topic: null,
    urgent: false,
    upset: false,
    reply_state: 'new',
    outcome: null,
    closed_at: null,
    ...over,
  } as HrListRow;
}

const kinds = (v: ReturnType<typeof hrRowView>) => v.tags.map((t) => t.kind);

describe('hrRowView', () => {
  it('recruiter: stage, reply, urgent, unread while a reply is due', () => {
    const v = hrRowView(
      hr({ stage_key: 'hr_interview', reply_state: 'reply_due', urgent: true }),
      'Omar Farouk'
    );
    expect(kinds(v)).toEqual(['stage', 'reply', 'urgent', 'unread']);
    expect(v.tags[0]).toEqual({
      kind: 'stage',
      stage: 'hr_interview',
      reached: 2,
    });
    expect(v.staffAvatar).toBe(false);
    expect(v.ownerFirstName).toBe('Omar');
  });

  it('no Unread unless the reply is due', () => {
    expect(kinds(hrRowView(hr({ reply_state: 'waiting' }), null))).toEqual([
      'stage',
      'reply',
    ]);
  });

  it('dept: topic tag (or No topic) and the Staff avatar', () => {
    const v = hrRowView(
      hr({ inbox: 'dept', stage_key: null, topic: 'payroll' }),
      null
    );
    expect(v.tags[0]).toEqual({ kind: 'topic', topic: 'payroll' });
    expect(v.staffAvatar).toBe(true);
    expect(v.ownerFirstName).toBeNull();
    const none = hrRowView(hr({ inbox: 'dept', stage_key: null }), null);
    expect(none.tags[0]).toEqual({ kind: 'noTopic' });
  });

  it('not sorted: only the Not sorted tag', () => {
    const v = hrRowView(null, 'Layla Hassan');
    expect(kinds(v)).toEqual(['notSorted']);
    expect(v.staffAvatar).toBe(false);
    expect(v.ownerFirstName).toBe('Layla');
  });

  it('closed: Closed replaces the reply state and drops Unread', () => {
    const v = hrRowView(
      hr({ reply_state: 'reply_due', urgent: true, closed_at: '2026-11-15' }),
      null
    );
    expect(kinds(v)).toEqual(['stage', 'closed', 'urgent']);
  });
});

describe('row name helpers', () => {
  it('firstName', () => {
    expect(firstName('  Priya  Nair ')).toBe('Priya');
    expect(firstName('')).toBeNull();
    expect(firstName(null)).toBeNull();
  });

  it('initialsOf', () => {
    expect(initialsOf('Papabathuni SAJEEVADIYA')).toBe('PS');
    expect(initialsOf('Aashish')).toBe('A');
    expect(initialsOf('Example employee A')).toBe('EA');
    expect(initialsOf('+971 50 000 0417')).toBe('90');
    expect(initialsOf('••••')).toBe('?');
  });
});
