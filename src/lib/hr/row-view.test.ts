import { describe, expect, it } from 'vitest';

import type { HrListRow } from '@/lib/hr/list-filters';

import { hrRowView } from './row-view';

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
  it('recruiter: stage, reply, urgent, upset', () => {
    const v = hrRowView(
      hr({
        stage_key: 'hr_interview',
        reply_state: 'reply_due',
        urgent: true,
        upset: true,
      })
    );
    expect(kinds(v)).toEqual(['stage', 'reply', 'urgent', 'upset']);
    expect(v.tags[0]).toEqual({
      kind: 'stage',
      stage: 'hr_interview',
      reached: 2,
    });
    expect(v.tags[1]).toEqual({ kind: 'reply', state: 'reply_due' });
    expect(v.staffAvatar).toBe(false);
  });

  it('no flags: stage and reply only', () => {
    expect(kinds(hrRowView(hr({ reply_state: 'waiting' })))).toEqual([
      'stage',
      'reply',
    ]);
  });

  it('dept: topic tag (or No topic) and the Staff ring', () => {
    const v = hrRowView(
      hr({ inbox: 'dept', stage_key: null, topic: 'payroll' })
    );
    expect(v.tags[0]).toEqual({ kind: 'topic', topic: 'payroll' });
    expect(v.staffAvatar).toBe(true);
    const none = hrRowView(hr({ inbox: 'dept', stage_key: null }));
    expect(none.tags[0]).toEqual({ kind: 'noTopic' });
  });

  it('not sorted: only the Not sorted tag', () => {
    const v = hrRowView(null);
    expect(kinds(v)).toEqual(['notSorted']);
    expect(v.staffAvatar).toBe(false);
  });

  it('closed: Closed replaces the reply state, flags stay', () => {
    const v = hrRowView(
      hr({ reply_state: 'reply_due', urgent: true, closed_at: '2026-11-15' })
    );
    expect(kinds(v)).toEqual(['stage', 'closed', 'urgent']);
  });
});
