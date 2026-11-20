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

import { WorklistView, type WorklistViewProps } from './worklist-view';

const ITEMS: WorklistItem[] = [
  {
    kind: 'case',
    id: 'c1aaaaaa-0000-4000-8000-000000000001',
    ref: 'c1aaaaaa',
    href: '/cases?case=c1aaaaaa-0000-4000-8000-000000000001',
    score: 300,
    reasons: ['sla_overdue', 'docs_missing'],
    assignees: ['u-omar'],
  },
  {
    kind: 'hr_conversation',
    id: 'h2bbbbbb-0000-4000-8000-000000000002',
    ref: 'h2bbbbbb',
    href: '/hr/recruiter?c=h2bbbbbb-0000-4000-8000-000000000002',
    score: 150,
    reasons: ['reply_due'],
    assignees: ['u-omar', 'u-layla'],
  },
  {
    kind: 'agent_draft',
    id: 'd3cccccc-0000-4000-8000-000000000003',
    ref: 'd3cccccc',
    href: '/hr/recruiter?c=h2bbbbbb-0000-4000-8000-000000000002',
    score: 40,
    reasons: ['draft_old'],
    assignees: [],
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

  it('shows rank, assignee names, score and reason labels', () => {
    const html = render({ mode: 'all' });
    expect(html).toContain('Omar, Layla');
    expect(html).toContain('>300<');
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

  it('all mode: the assigned-to select lists Anyone and each member', () => {
    const html = render({ mode: 'all', assignedTo: 'u-layla' });
    expect(html).toContain('data-testid="worklist-assigned-to"');
    expect(html).toContain('<option value="">Anyone</option>');
    expect(html).toContain(
      '<option value="u-layla" selected="">Layla</option>'
    );
  });

  it('is read only: no buttons and no forms', () => {
    for (const mode of ['own', 'all'] as const) {
      const html = render({ mode });
      expect(html).not.toContain('<button');
      expect(html).not.toContain('<form');
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
