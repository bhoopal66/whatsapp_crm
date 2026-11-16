import { describe, expect, it } from 'vitest';

import {
  HR_EMBED,
  HR_LIST_DEFAULTS,
  hrQueryOps,
  hrSelectEmbeds,
  matchesHrFilters,
  parseHrListParams,
  writeHrListParams,
  type HrListFilters,
  type HrListRow,
} from './list-filters';

const f = (o: Partial<HrListFilters>): HrListFilters => ({
  ...HR_LIST_DEFAULTS,
  ...o,
});
const row = (o: Partial<HrListRow> = {}): HrListRow => ({
  inbox: 'recruiter',
  stage_key: 'cv_review',
  topic: null,
  urgent: false,
  upset: false,
  reply_state: 'new',
  outcome: null,
  closed_at: null,
  ...o,
});

describe('URL state', () => {
  it('round-trips and keeps the inbox keys (?c=)', () => {
    const want = f({
      tab: 'recruiter',
      stage: 'hr_interview',
      reply: 'reply_due',
      urgent: true,
      mine: true,
      closed: true,
    });
    const out = writeHrListParams(new URLSearchParams('c=abc'), want);
    expect(out.get('c')).toBe('abc');
    expect(parseHrListParams(out)).toEqual(want);
  });

  it('writes nothing for the defaults', () => {
    expect(
      writeHrListParams(new URLSearchParams(), HR_LIST_DEFAULTS).toString()
    ).toBe('');
  });

  it('drops unknown values and filters that do not fit the tab', () => {
    expect(
      parseHrListParams(new URLSearchParams('hrTab=x&hrStage=nope'))
    ).toEqual(HR_LIST_DEFAULTS);
    expect(
      parseHrListParams(new URLSearchParams('hrTab=dept&hrStage=cv_review'))
        .stage
    ).toBeNull();
    const u = parseHrListParams(
      new URLSearchParams('hrTab=unsorted&hrReply=new&hrUrgent=1')
    );
    expect([u.reply, u.urgent]).toEqual([null, false]);
  });
});

describe('query mapping', () => {
  it('All tab, closed hidden: plain embed plus the closed-row probe', () => {
    expect(hrSelectEmbeds(HR_LIST_DEFAULTS)).toBe(
      `${HR_EMBED},hr_closed:hr_conversations(conversation_id)`
    );
    expect(hrQueryOps(HR_LIST_DEFAULTS, 'u1')).toEqual([
      { op: 'not_is', column: 'hr_closed.closed_at', value: null },
      { op: 'is', column: 'hr_closed', value: null },
    ]);
  });

  it('All tab with closed shown filters nothing', () => {
    expect(hrSelectEmbeds(f({ closed: true }))).toBe(HR_EMBED);
    expect(hrQueryOps(f({ closed: true }), 'u1')).toEqual([]);
  });

  it('Recruitment tab goes inner and filters on the embed', () => {
    const x = f({
      tab: 'recruiter',
      stage: 'ai_interview',
      reply: 'waiting',
      urgent: true,
    });
    expect(hrSelectEmbeds(x)).toContain('hr_conversations!inner(');
    expect(hrQueryOps(x, null)).toEqual([
      { op: 'eq', column: 'hr.inbox', value: 'recruiter' },
      { op: 'eq', column: 'hr.stage_key', value: 'ai_interview' },
      { op: 'eq', column: 'hr.reply_state', value: 'waiting' },
      { op: 'eq', column: 'hr.urgent', value: true },
      { op: 'is', column: 'hr.closed_at', value: null },
    ]);
  });

  it('Not sorted lists chats with no HR row', () => {
    expect(hrSelectEmbeds(f({ tab: 'unsorted' }))).toBe(HR_EMBED);
    expect(hrQueryOps(f({ tab: 'unsorted' }), null)).toEqual([
      { op: 'is', column: 'hr', value: null },
    ]);
  });

  it('Mine is assigned to me, or unassigned and mine', () => {
    expect(hrQueryOps(f({ tab: 'unsorted', mine: true }), 'u1')).toContainEqual(
      {
        op: 'or',
        filter:
          'assigned_agent_id.eq.u1,and(assigned_agent_id.is.null,user_id.eq.u1)',
      }
    );
  });
});

describe('matchesHrFilters', () => {
  it('hides a closed row unless Closed is on', () => {
    const r = { hr: row({ closed_at: '2026-11-16T00:00:00Z' }) };
    expect(matchesHrFilters(r, HR_LIST_DEFAULTS, null)).toBe(false);
    expect(matchesHrFilters(r, f({ closed: true }), null)).toBe(true);
  });

  it('drops a row whose stage moved off the filter', () => {
    const x = f({ tab: 'recruiter', stage: 'cv_review' });
    expect(matchesHrFilters({ hr: row() }, x, null)).toBe(true);
    expect(
      matchesHrFilters({ hr: row({ stage_key: 'hr_interview' }) }, x, null)
    ).toBe(false);
    expect(
      matchesHrFilters(
        { hr: row({ inbox: 'dept', stage_key: null }) },
        f({ tab: 'recruiter' }),
        null
      )
    ).toBe(false);
  });

  it('Not sorted keeps only rows without HR; All keeps both', () => {
    expect(matchesHrFilters({ hr: null }, f({ tab: 'unsorted' }), null)).toBe(
      true
    );
    expect(matchesHrFilters({ hr: row() }, f({ tab: 'unsorted' }), null)).toBe(
      false
    );
    expect(matchesHrFilters({ hr: null }, HR_LIST_DEFAULTS, null)).toBe(true);
    expect(matchesHrFilters({ hr: null }, f({ urgent: true }), null)).toBe(
      false
    );
  });

  it('Mine follows the assignment, then the owner', () => {
    const x = f({ mine: true });
    expect(
      matchesHrFilters({ hr: null, assigned_agent_id: 'u1' }, x, 'u1')
    ).toBe(true);
    expect(
      matchesHrFilters(
        { hr: null, assigned_agent_id: null, user_id: 'u1' },
        x,
        'u1'
      )
    ).toBe(true);
    expect(
      matchesHrFilters(
        { hr: null, assigned_agent_id: 'u2', user_id: 'u1' },
        x,
        'u1'
      )
    ).toBe(false);
  });
});
