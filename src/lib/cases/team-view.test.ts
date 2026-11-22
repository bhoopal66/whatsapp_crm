import { describe, expect, it } from 'vitest';

import { mergeTeamPages, teamInboxUrls, TEAM_PAGE_LIMIT } from './team-view';
import { EMPTY_FILTERS, parseInboxPage, type InboxRow } from './ui';

const NOW = new Date('2026-11-22T12:00:00Z');
const ago = (h: number) =>
  new Date(NOW.getTime() - h * 3_600_000).toISOString();

const row = (over: Partial<InboxRow> & { caseId: string }): InboxRow =>
  parseInboxPage({
    rows: [{ stage: 'Submitted', agentId: 'u-a', ...over }],
  }).rows[0]!;

describe('teamInboxUrls', () => {
  it('asks once per person, keeping the other filters, a full page each', () => {
    const urls = teamInboxUrls({ ...EMPTY_FILTERS, bank: 'ADCB', agent: 'x' }, [
      'u-a',
      'u-b',
      'u-a',
    ]);
    expect(urls).toHaveLength(2);
    const qs = urls.map((u) => new URL(u, 'https://x.invalid').searchParams);
    expect(qs.map((q) => q.get('agent'))).toEqual(['u-a', 'u-b']);
    for (const q of qs) {
      expect(q.get('bank')).toBe('ADCB');
      expect(q.get('limit')).toBe(String(TEAM_PAGE_LIMIT));
    }
  });
});

describe('mergeTeamPages', () => {
  it('most overdue first: the longest-overdue SLA, then overdue tasks, then the due time', () => {
    const pages = [
      {
        rows: [
          row({ caseId: 'k1', slaState: 'overdue', dueAt: ago(2) }),
          row({ caseId: 'k3', dueAt: ago(-5) }),
        ],
        nextCursor: null,
      },
      {
        rows: [
          row({ caseId: 'k0', slaState: 'overdue', dueAt: ago(9) }),
          row({ caseId: 'k2', openTaskOverdueCount: 3, dueAt: ago(-1) }),
        ],
        nextCursor: null,
      },
    ];
    expect(
      mergeTeamPages(pages, 'most_overdue', NOW).rows.map((r) => r.caseId)
    ).toEqual(['k0', 'k1', 'k2', 'k3']);
  });

  it('due soonest by due time (none last); stalest by last activity', () => {
    const rows = [
      row({ caseId: 'a', dueAt: null, lastActivityAt: ago(1) }),
      row({ caseId: 'b', dueAt: ago(-2), lastActivityAt: ago(30) }),
      row({ caseId: 'c', dueAt: ago(-1), lastActivityAt: ago(5) }),
    ];
    const page = [{ rows, nextCursor: null }];
    expect(
      mergeTeamPages(page, 'due_soonest', NOW).rows.map((r) => r.caseId)
    ).toEqual(['c', 'b', 'a']);
    expect(
      mergeTeamPages(page, 'stalest', NOW).rows.map((r) => r.caseId)
    ).toEqual(['b', 'c', 'a']);
  });

  it('lists a case once and says when a page was full', () => {
    const merged = mergeTeamPages(
      [
        { rows: [row({ caseId: 'k1' })], nextCursor: 'more' },
        { rows: [row({ caseId: 'k1' })], nextCursor: null },
      ],
      'most_overdue',
      NOW
    );
    expect(merged.rows).toHaveLength(1);
    expect(merged.truncated).toBe(true);
    expect(mergeTeamPages([], 'stalest', NOW)).toEqual({
      rows: [],
      truncated: false,
    });
  });
});
