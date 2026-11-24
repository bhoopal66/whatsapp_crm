/**
 * My worklist's pure view (package 029c test/029/worklist.view.test.ts,
 * the cases that apply to wacrm: rows and links in ranked order, the
 * assigned-to select only for leaders and up, loading and empty, and
 * generated titles only). Rendered server-side: the test env has no DOM.
 */
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';
import type { WorklistItem, WorklistMode } from '@/lib/worklist/rank';

import {
  WORKLIST_MY_TEAM,
  WorklistView,
  type WorklistViewProps,
} from './worklist-view';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const H = 3_600_000;

const ITEMS: WorklistItem[] = [
  {
    kind: 'case',
    id: 'c1aaaaaa-0000-4000-8000-000000000001',
    ref: 'c1aaaaaa',
    href: '/cases?case=c1aaaaaa-0000-4000-8000-000000000001',
    score: 300,
    reasons: ['sla_overdue', 'docs_missing'],
    assignees: ['u-omar'],
    timing: { state: 'overdue', at: NOW - 2 * H },
  },
  {
    kind: 'hr_conversation',
    id: 'h2bbbbbb-0000-4000-8000-000000000002',
    ref: 'h2bbbbbb',
    href: '/hr/recruiter?c=h2bbbbbb-0000-4000-8000-000000000002',
    score: 150,
    reasons: ['reply_due'],
    assignees: ['u-omar', 'u-layla'],
    timing: { state: 'waiting', at: NOW - 30 * 60_000 },
  },
  {
    kind: 'agent_draft',
    id: 'd3cccccc-0000-4000-8000-000000000003',
    ref: 'd3cccccc',
    href: '/hr/recruiter?c=h2bbbbbb-0000-4000-8000-000000000002',
    score: 40,
    reasons: ['draft_old'],
    assignees: [],
    timing: null,
  },
];

const NAMES: Record<string, string> = { 'u-omar': 'Omar', 'u-layla': 'Layla' };

function render(
  over: Partial<WorklistViewProps> & { mode: WorklistMode | null }
) {
  const props: WorklistViewProps = {
    items: ITEMS,
    nameOf: (id) => NAMES[id] ?? null,
    assignedTo: '',
    onAssignedTo: () => undefined,
    members: [
      { userId: 'u-omar', name: 'Omar' },
      { userId: 'u-layla', name: 'Layla' },
    ],
    now: NOW,
    ...over,
  };
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <WorklistView {...props} />
    </NextIntlClientProvider>
  );
}

const rowsOf = (html: string) =>
  [
    ...html.matchAll(
      /data-testid="worklist-row" data-kind="([a-z_]+)" data-id="([^"]+)"/g
    ),
  ].map((m) => ({ kind: m[1], id: m[2] }));

describe('WorklistView', () => {
  it('renders rows in ranked order, each title linking to its screen', () => {
    const html = render({ mode: 'all' });
    expect(rowsOf(html)).toEqual(
      ITEMS.map((i) => ({ kind: i.kind, id: i.id }))
    );
    for (const it of ITEMS) {
      expect(html).toContain(`href="${it.href}"`);
    }
    expect(html).toContain('>Case c1aaaaaa</a>');
    expect(html).toContain('>HR conversation h2bbbbbb</a>');
    expect(html).toContain('>Agent draft d3cccccc awaiting approval</a>');
    expect(html).toContain('aria-label="Items needing action"');
  });

  it('shows rank, assignee names, the timing in words and reason labels', () => {
    const html = render({ mode: 'all' });
    expect(html).toContain('Omar, Layla');
    // The score orders the list; it is never shown as a number.
    expect(html).not.toContain('>300<');
    expect(html).toContain('Overdue by 2 h');
    expect(html).toContain('Waiting 30 min');
    expect(html).toContain('aria-label="Nothing due"');
    // 029c's own reasons and hire fast's reused labels.
    expect(html).toContain('>SLA overdue<');
    expect(html).toContain('>Documents missing<');
    expect(html).toContain('>Draft over 24 h old<');
    expect(html).toContain(`>${en.Hr.hireFast.reason.reply_due}<`);
  });

  it('own mode: no assigned-to select', () => {
    const html = render({ mode: 'own' });
    expect(html).toContain('data-mode="own"');
    expect(html).not.toContain('data-testid="worklist-assigned-to"');
    expect(rowsOf(html)).toHaveLength(3);
  });

  it('all mode: the assigned-to filter shows the chosen member', () => {
    const html = render({ mode: 'all', assignedTo: 'u-layla' });
    expect(html).toContain('data-testid="worklist-assigned-to"');
    expect(html).toContain('data-value="u-layla"');
    expect(html).toContain('>Layla<');
    expect(html).not.toContain('<select');
  });

  it('all mode: "My team" reads as chosen, with a note when the viewer leads nobody', () => {
    const html = render({
      mode: 'all',
      assignedTo: WORKLIST_MY_TEAM,
      teamOption: true,
      noTeam: true,
    });
    expect(html).toContain('>My team<');
    expect(html).toContain('data-testid="worklist-no-team"');
    expect(
      render({ mode: 'all', assignedTo: WORKLIST_MY_TEAM, teamOption: true })
    ).not.toContain('data-testid="worklist-no-team"');
  });

  it('is read only: no forms, and no buttons beyond the filter', () => {
    for (const mode of ['own', 'all'] as const) {
      const html = render({ mode });
      expect(html).not.toContain('<form');
      const buttons = html.match(/<button/g)?.length ?? 0;
      expect(buttons).toBe(mode === 'all' ? 1 : 0);
    }
  });

  it('loading: a status line and no table', () => {
    const html = render({ mode: 'own', items: null });
    expect(html).toContain('role="status"');
    expect(html).toContain('Loading worklist...');
    expect(html).not.toContain('<table');
  });

  it('role not known yet (mode null): loading, never the empty line', () => {
    const html = render({ mode: null });
    expect(html).toContain('Loading worklist...');
    expect(html).not.toContain('Nothing needs action right now.');
    expect(html).not.toContain('<table');
  });

  it('an assignee missing from the members list shows Unknown person, not the id', () => {
    const html = render({
      mode: 'all',
      items: [{ ...ITEMS[0]!, assignees: ['u-omar', 'u-gone-9f3'] }],
    });
    expect(html).toContain('Omar, Unknown person');
    expect(html).not.toContain('u-gone-9f3');
  });

  it('empty: the empty line and no table', () => {
    const html = render({ mode: 'all', items: [] });
    expect(html).toContain('data-testid="worklist-empty"');
    expect(html).toContain('Nothing needs action right now.');
    expect(html).not.toContain('<table');
  });

  it('none mode (bank guest): the empty state, even with items', () => {
    const html = render({ mode: 'none' });
    expect(html).toContain('Nothing needs action right now.');
    expect(rowsOf(html)).toHaveLength(0);
    expect(html).not.toContain('data-testid="worklist-assigned-to"');
  });
});

describe('WorklistView when a read failed', () => {
  const notes = (html: string) =>
    [...html.matchAll(/data-testid="worklist-load-note"/g)].length;
  const retries = (html: string) => html.split(en.States.retry).length - 1;
  const onRetry = () => undefined;

  it('shows one error with Retry when nothing could be read', () => {
    const html = render({
      mode: 'own',
      items: [],
      load: { missing: ['hr', 'drafts', 'cases'], stale: [] },
      onRetry,
    });
    expect(html).toContain(en.States.errorTitle);
    expect(retries(html)).toBe(1);
    expect(notes(html)).toBe(0);
    expect(html).not.toContain('worklist-empty');
  });

  it('shows loading while that Retry is on its way', () => {
    const html = render({
      mode: 'own',
      items: [],
      load: { missing: ['hr', 'drafts', 'cases'], stale: [] },
      onRetry,
      retrying: true,
    });
    expect(html).toContain(en.Worklist.loading);
    expect(html).not.toContain(en.States.errorTitle);
  });

  it('names the missing parts and never says nothing needs action', () => {
    const html = render({
      mode: 'own',
      items: [],
      load: { missing: ['hr', 'cases'], stale: [] },
      onRetry,
      emptyLabel: en.WorklistWaiting.emptyOthers,
    });
    expect(html).toContain('HR conversations and cases');
    expect(html).not.toContain('worklist-empty');
    expect(html).not.toContain('needs action right now');
    expect(retries(html)).toBe(1);
  });

  it('keeps the rows beside the notice, with one Retry', () => {
    const html = render({
      mode: 'own',
      load: { missing: ['drafts'], stale: ['cases'] },
      onRetry,
    });
    expect(rowsOf(html)).toHaveLength(ITEMS.length);
    expect(notes(html)).toBe(2);
    expect(retries(html)).toBe(1);
  });

  it('says quietly that old rows could not be refreshed', () => {
    const html = render({
      mode: 'own',
      load: { missing: [], stale: ['cases'] },
      onRetry,
    });
    expect(html).toContain('Could not refresh: cases.');
    expect(html).toContain('data-tone="quiet"');
    expect(rowsOf(html)).toHaveLength(ITEMS.length);
    expect(retries(html)).toBe(1);
  });

  it('says when only the first cases were read, and proves nothing empty', () => {
    const load = { missing: [], stale: [], casesTruncated: true };
    const html = render({ mode: 'own', load });
    expect(html).toContain('Showing the first 1,000 cases.');
    expect(rowsOf(html)).toHaveLength(ITEMS.length);
    expect(render({ mode: 'own', items: [], load })).not.toContain(
      'worklist-empty'
    );
    expect(render({ mode: 'none', items: [], load })).not.toContain(
      'Showing the first'
    );
    expect(
      render({ mode: 'own', load: { ...load, casesTruncated: false } })
    ).not.toContain('Showing the first');
  });

  it('says nothing to a guest, who has no list', () => {
    const html = render({
      mode: 'none',
      items: [],
      load: { missing: ['hr', 'drafts', 'cases'], stale: [] },
      onRetry,
    });
    expect(html).not.toContain(en.States.errorTitle);
  });
});
