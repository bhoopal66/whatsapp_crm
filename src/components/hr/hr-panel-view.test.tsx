import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import {
  closeChoices,
  panelActions,
  stepperSteps,
  type CloseChoice,
} from '@/lib/hr/panel';
import type { HrConversation, HrRoles } from '@/lib/hr/types';

import { HrPanelView, type HrPanelViewProps } from './hr-panel-view';

// The node environment cannot mount the data-loading HrPanel, so this
// renders its presentational body with the props HrPanel would compute.
// It pins the package's "Conversation" pane: which fieldsets show, in
// which order, and what each one offers.

const ADMIN: HrRoles = { admin: true, recruiter: null, dept: null };

function row(over: Partial<HrConversation> = {}): HrConversation {
  return {
    conversation_id: 'c1',
    account_id: 'a1',
    inbox: 'recruiter',
    stage_key: 'ai_interview',
    topic: null,
    urgent: false,
    upset: true,
    last_inbound_at: null,
    last_outbound_at: null,
    reply_state: 'reply_due',
    outcome: null,
    closed_at: null,
    interview_at: null,
    created_at: '2026-11-16T00:00:00Z',
    created_by: null,
    updated_at: '2026-11-16T00:00:00Z',
    ...over,
  };
}

const noop = () => {};

function render(
  r: HrConversation | null,
  over: Partial<HrPanelViewProps> = {}
): string {
  const props: HrPanelViewProps = {
    contactName: 'Vishnu',
    busy: false,
    row: r,
    kinds: r ? [] : ['candidate', 'employee'],
    actions: r ? panelActions(r, ADMIN) : null,
    steps: r ? stepperSteps(r, ADMIN, r.stage_key) : [],
    tasks: [],
    doneBusy: new Set(),
    pendingClose: null,
    onOpen: noop,
    onTopic: noop,
    onPickStage: noop,
    onFlag: noop,
    onAskClose: noop,
    onConfirmClose: noop,
    onReopen: noop,
    onTaskDone: noop,
    ownerId: null,
    ownerName: null,
    ownerOptions: null,
    ownerUnassign: false,
    onOwner: noop,
    onInterview: noop,
    ...over,
  };
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <HrPanelView {...props} />
    </NextIntlClientProvider>
  );
}

/** Text positions, to assert order. */
const at = (html: string, s: string) => {
  const i = html.indexOf(s);
  expect(i, s).toBeGreaterThanOrEqual(0);
  return i;
};

describe('HrPanelView: recruitment chat', () => {
  it('lays out the Conversation pane with every tag control', () => {
    const html = render(row());
    for (const s of [
      'Conversation',
      'Vishnu',
      'Inbox: Recruiter HR',
      'Tags',
      'CV review',
      'AI interview',
      'HR interview',
      'Manager interview',
      'Topic',
      'No topic',
      'Moves to HR department',
      'Urgent',
      'Upset',
      'Reply due',
      'Set automatically from who wrote last',
      'Hired',
      'Not selected',
      'Withdrawn',
    ])
      expect(html).toContain(s);
    // Stage, Topic, Flags, reply line, Close: top to bottom.
    const order = [
      '<legend class="text-muted-foreground px-1 text-xs">Stage</legend>',
      'Moves to HR department',
      '>Flags</legend>',
      'Set automatically',
      '>Close</legend>',
    ].map((s) => at(html, s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('highlights the current stage and shows pressed flags', () => {
    const html = render(row());
    expect(html).toMatch(/aria-current="step"[^>]*>AI interview</);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Upset</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Urgent</);
  });

  it('asks before closing with an outcome', () => {
    const hired = closeChoices(row())[0] as CloseChoice;
    const html = render(row(), { pendingClose: hired });
    expect(html).toContain('Close as Hired?');
    expect(html).toContain('Confirm');
    expect(html).not.toContain('Not selected');
  });

  it('shows the outcome and Reopen once closed', () => {
    const html = render(
      row({ closed_at: '2026-11-16T01:00:00Z', outcome: 'hired' })
    );
    expect(html).toContain('Closed: Hired');
    expect(html).toContain('Reopen');
    expect(html).not.toContain('Withdrawn');
    // A closed chat moves nowhere.
    expect(html).not.toContain('Moves to HR department');
  });
});

describe('HrPanelView: HR department chat', () => {
  const dept = row({ inbox: 'dept', stage_key: null, topic: 'payroll' });

  it('leads with the topic and offers the move to recruitment', () => {
    const html = render(dept);
    for (const s of [
      'Staff conversation',
      'Inbox: HR department',
      'Moves to Recruiter HR',
      'Close conversation',
      'Urgent',
    ])
      expect(html).toContain(s);
    expect(html).not.toContain('>Tags<');
    expect(html).not.toContain('Hired');
    expect(at(html, 'Topic')).toBeLessThan(at(html, '>Stage</legend>'));
  });

  it('asks before closing', () => {
    const html = render(dept, { pendingClose: closeChoices(dept)[0] });
    expect(html).toContain('Close this conversation?');
  });
});

describe('HrPanelView: Interview', () => {
  const FIELD = '>Interview</legend>';
  const REC_MEMBER: HrRoles = { admin: false, recruiter: 'member', dept: null };
  const DEPT_LEAD: HrRoles = { admin: false, recruiter: null, dept: 'lead' };

  it('an open recruitment chat offers the time, under the stage', () => {
    const html = render(row());
    expect(html).toContain(FIELD);
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('aria-label="Interview time (Dubai time)"');
    expect(html).toContain('No interview time set');
    expect(html).toContain('within the 24 hours before it');
    expect(at(html, '>Stage</legend>')).toBeLessThan(at(html, FIELD));
    expect(at(html, FIELD)).toBeLessThan(at(html, 'Moves to HR department'));
    // Nothing saved: nothing to clear, and an empty draft saves nothing.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Clear<\/button>/);
  });

  it('shows the saved time in Dubai time and offers Clear', () => {
    const html = render(row({ interview_at: '2099-03-01T06:30:00Z' }));
    expect(html).toContain('value="2099-03-01T10:30"');
    expect(html).toMatch(/Set for [^<]*10:30[^<]*\(Dubai time\)/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Clear<\/button>/);
  });

  it('refuses past times: the input starts at now', () => {
    const html = render(row());
    expect(html).toMatch(/min="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"/);
  });

  it('is not offered on a department chat', () => {
    const dept = row({ inbox: 'dept', stage_key: null, topic: 'payroll' });
    expect(render(dept)).toContain('>Stage</legend>');
    expect(render(dept)).not.toContain(FIELD);
    expect(render(dept)).not.toContain('datetime-local');
  });

  it('is not offered on a closed chat', () => {
    const closed = row({
      closed_at: '2026-11-16T01:00:00Z',
      outcome: 'hired',
      interview_at: '2099-03-01T06:30:00Z',
    });
    expect(render(closed)).not.toContain(FIELD);
  });

  it('is offered to a recruiter member, not to someone who may not edit', () => {
    const r = row({ interview_at: '2099-03-01T06:30:00Z' });
    const as = (roles: HrRoles) =>
      render(r, {
        actions: panelActions(r, roles),
        steps: stepperSteps(r, roles, r.stage_key),
      });
    expect(as(REC_MEMBER)).toContain(FIELD);
    expect(as(DEPT_LEAD)).not.toContain(FIELD);
    expect(as(DEPT_LEAD)).not.toContain('2099-03-01T10:30');
  });
});

describe('HrPanelView: not sorted', () => {
  it('offers the kinds to track it as', () => {
    const html = render(null);
    expect(html).toContain('Track in HR as');
    expect(html).toContain('Candidate');
    expect(html).toContain('Employee');
    expect(html).not.toContain('Inbox:');
  });
});

describe('HrPanelView: Owner', () => {
  const ownerSelect = (html: string, name: string) =>
    (html.match(/<select[^>]*>[\s\S]*?<\/select>/g) ?? []).find((s) =>
      s.includes(name)
    ) ?? '';

  it('a lead picks among the team or Unassigned, under Flags', () => {
    const html = render(row(), {
      ownerId: 'omar',
      ownerName: 'Omar Farouk',
      ownerOptions: [
        { userId: 'omar', name: 'Omar Farouk' },
        { userId: 'layla', name: 'Layla Haddad' },
      ],
      ownerUnassign: true,
    });
    expect(html).toContain('Owner: Omar Farouk');
    const select = ownerSelect(html, 'Layla Haddad');
    expect(select).toMatch(/Unassigned[\s\S]*Omar Farouk[\s\S]*Layla Haddad/);
    expect(at(html, '>Flags</legend>')).toBeLessThan(at(html, '>Owner<'));
    expect(at(html, '>Owner<')).toBeLessThan(at(html, 'Set automatically'));
  });

  it('a member on an unowned chat may only claim it', () => {
    const html = render(row(), {
      ownerOptions: [{ userId: 'me', name: 'Sara Ali' }],
      ownerUnassign: true,
    });
    expect(html).toContain('Owner: Unassigned');
    const select = ownerSelect(html, 'Sara Ali');
    expect(select.match(/<option/g)).toHaveLength(2);
    expect(select).toContain('Unassigned');
  });

  it("someone else's chat shows the name only", () => {
    const html = render(row(), { ownerId: 'omar', ownerName: 'Omar Farouk' });
    expect(html).toContain('Owner: Omar Farouk');
    expect(html).toMatch(/>Owner<\/span><span class="text-xs">Omar Farouk</);
    expect(html).not.toContain('Unassigned');
  });
});

describe('HrPanelView: tasks read failed', () => {
  const task = {
    id: 't1',
    title: 'Call the candidate',
    due_at: null,
  } as unknown as HrPanelViewProps['tasks'][number];

  it('an empty list that failed is not "No open HR tasks"', () => {
    const html = render(row(), { tasksFailed: true });
    expect(html).toContain('load the HR tasks.');
    expect(html).toContain('Retry');
    expect(html).not.toContain('No open HR tasks');
  });

  it('a held list stays below the failure line', () => {
    const html = render(row(), { tasksFailed: true, tasks: [task] });
    expect(at(html, 'load the HR tasks')).toBeLessThan(
      at(html, 'Call the candidate')
    );
  });

  it('a good read still says there are no tasks', () => {
    const html = render(row());
    expect(html).toContain('No open HR tasks');
    expect(html).not.toContain('load the HR tasks');
  });
});
