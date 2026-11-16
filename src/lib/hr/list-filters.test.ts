import { describe, expect, it } from 'vitest';

import {
  applyHrQueryOps,
  HR_EMBED,
  HR_LIST_DEFAULTS,
  hrChangeAction,
  hrInboxUrl,
  hrQueryOps,
  hrSelectEmbeds,
  hrTabCounts,
  matchesHrFilters,
  parseHrListParams,
  switchHrTab,
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

describe('applyHrQueryOps', () => {
  type Call = [string, ...unknown[]];
  class FakeQuery {
    calls: Call[] = [];
    eq(column: string, value: string | boolean) {
      this.calls.push(['eq', column, value]);
      return this;
    }
    in(column: string, values: string[]) {
      this.calls.push(['in', column, values]);
      return this;
    }
    is(column: string, value: null) {
      this.calls.push(['is', column, value]);
      return this;
    }
    not(column: string, operator: string, value: null) {
      this.calls.push(['not', column, operator, value]);
      return this;
    }
  }

  it('maps each column op to its builder call, in order', () => {
    const q = new FakeQuery();
    const out = applyHrQueryOps(q, [
      { op: 'eq', column: 'hr.inbox', value: 'recruiter' },
      { op: 'eq', column: 'hr.urgent', value: true },
      { op: 'is', column: 'hr.closed_at', value: null },
      { op: 'not_is', column: 'hr_closed.closed_at', value: null },
    ]);
    expect(out.query).toBe(q);
    expect(q.calls).toEqual([
      ['eq', 'hr.inbox', 'recruiter'],
      ['eq', 'hr.urgent', true],
      ['is', 'hr.closed_at', null],
      ['not', 'hr_closed.closed_at', 'is', null],
    ]);
    expect(out.orGroups).toEqual([]);
  });

  it('hands `or` ops back as groups instead of calling the builder', () => {
    const q = new FakeQuery();
    const ops = hrQueryOps({ ...HR_LIST_DEFAULTS, mine: true }, 'u1');
    const out = applyHrQueryOps(q, ops);
    expect(out.orGroups).toEqual([
      'assigned_agent_id.eq.u1,and(assigned_agent_id.is.null,user_id.eq.u1)',
    ]);
    expect(q.calls).toEqual([
      ['not', 'hr_closed.closed_at', 'is', null],
      ['is', 'hr_closed', null],
    ]);
  });

  it('touches nothing with no ops', () => {
    const q = new FakeQuery();
    expect(applyHrQueryOps(q, [])).toEqual({ query: q, orGroups: [] });
    expect(q.calls).toEqual([]);
  });
});

describe('hrTabCounts', () => {
  it('adds both inboxes and the unsorted chats for All', () => {
    const inbox = (all: number) => ({ all, unread: 9, mine: 9, urgent: 9 });
    expect(
      hrTabCounts({ recruiter: inbox(3), dept: inbox(5), unsorted: 2 })
    ).toEqual({ all: 10, recruiter: 3, dept: 5, unsorted: 2 });
  });
});

describe('switchHrTab', () => {
  const busy = f({
    tab: 'recruiter',
    stage: 'hr_interview',
    reply: 'reply_due',
    urgent: true,
    mine: true,
    closed: true,
  });

  it('clears the stage on leaving Recruitment and keeps the rest', () => {
    expect(switchHrTab(busy, 'dept')).toEqual({
      ...busy,
      tab: 'dept',
      stage: null,
    });
  });

  it('clears the topic on leaving HR department', () => {
    const dept = f({ tab: 'dept', topic: 'payroll' });
    expect(switchHrTab(dept, 'recruiter')).toEqual(f({ tab: 'recruiter' }));
  });

  it('drops reply and Urgent on Not sorted (no HR row to match)', () => {
    expect(switchHrTab(busy, 'unsorted')).toEqual(
      f({ tab: 'unsorted', mine: true, closed: true })
    );
  });

  it('is what the URL reads back', () => {
    for (const tab of ['all', 'recruiter', 'dept', 'unsorted'] as const) {
      const next = switchHrTab(busy, tab);
      expect(
        parseHrListParams(writeHrListParams(new URLSearchParams(), next))
      ).toEqual(next);
    }
  });
});

describe('hrInboxUrl', () => {
  it('keeps the HR keys, sets c and drops the rest', () => {
    expect(
      hrInboxUrl('/hr-inbox', '?hrTab=dept&hrTopic=payroll&c=old&tag=x', 'new')
    ).toBe('/hr-inbox?hrTab=dept&hrTopic=payroll&c=new');
  });

  it('is the bare path with nothing to keep', () => {
    expect(hrInboxUrl('/hr-inbox', '?c=old', null)).toBe('/hr-inbox');
  });
});

describe('hrChangeAction', () => {
  it('ignores a DELETE of a chat the list does not hold', () => {
    expect(hrChangeAction(false, null, f({}), 'v')).toBe('ignore');
    expect(hrChangeAction(false, null, f({ tab: 'unsorted' }), 'v')).toBe(
      'ignore'
    );
  });
  it('patches a held chat, deleted or not', () => {
    expect(hrChangeAction(true, null, f({}), 'v')).toBe('patch');
    expect(hrChangeAction(true, row(), f({}), 'v')).toBe('patch');
  });
  it('reloads for an unheld chat that may now belong', () => {
    expect(hrChangeAction(false, row(), f({}), 'v')).toBe('reload');
    expect(hrChangeAction(false, row(), f({ tab: 'dept' }), 'v')).toBe(
      'ignore'
    );
  });
});

describe('topic chips (migration 201)', () => {
  it('round-trips on the dept tab and is dropped elsewhere', () => {
    const want = f({ tab: 'dept', topicGroup: 'letters' });
    const out = writeHrListParams(new URLSearchParams(), want);
    expect(out.get('hrTopicGroup')).toBe('letters');
    expect(parseHrListParams(out)).toEqual(want);
    out.set('hrTab', 'recruiter');
    expect(parseHrListParams(out).topicGroup).toBeNull();
    out.set('hrTab', 'dept');
    out.set('hrTopicGroup', 'nope');
    expect(parseHrListParams(out).topicGroup).toBeNull();
  });

  it('is pushed as an in op and applied as .in()', () => {
    const ops = hrQueryOps(f({ tab: 'dept', topicGroup: 'letters' }), null);
    expect(ops).toContainEqual({
      op: 'in',
      column: 'hr.topic',
      values: ['offer_letter', 'warning_letter'],
    });
    const calls: unknown[][] = [];
    const q = {
      eq: () => q,
      is: () => q,
      not: () => q,
      in: (...a: unknown[]) => (calls.push(a), q),
    };
    applyHrQueryOps(q, ops);
    expect(calls).toEqual([['hr.topic', ['offer_letter', 'warning_letter']]]);
  });

  it('is re-checked client-side and combines with the topic select', () => {
    const d = f({ tab: 'dept', topicGroup: 'letters' });
    const r = (topic: HrListRow['topic']) =>
      row({ inbox: 'dept', stage_key: null, topic });
    expect(matchesHrFilters({ hr: r('offer_letter') }, d, null)).toBe(true);
    expect(matchesHrFilters({ hr: r('payroll') }, d, null)).toBe(false);
    expect(matchesHrFilters({ hr: r(null) }, d, null)).toBe(false);
    const both = { ...d, topic: 'warning_letter' as const };
    expect(matchesHrFilters({ hr: r('offer_letter') }, both, null)).toBe(false);
    expect(matchesHrFilters({ hr: r('warning_letter') }, both, null)).toBe(
      true
    );
  });

  it('is cleared on a tab move', () => {
    const d = f({ tab: 'dept', topicGroup: 'exits' });
    expect(switchHrTab(d, 'all').topicGroup).toBeNull();
  });
});
