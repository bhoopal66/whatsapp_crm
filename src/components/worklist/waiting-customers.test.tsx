/**
 * The worklist's "Customers waiting for a reply" section, rendered
 * server-side (no DOM in the test env): oldest first, each row opening
 * the chat, unassigned flagged in words, the wait in clock time with
 * the business-hours part, loading and empty states. Also the worklist
 * itself no longer says "Nothing needs action" while customers wait.
 */
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';
import { parseWaitingChats } from '@/lib/worklist/waiting';

import { WaitingCustomers } from './waiting-customers';
import { WorklistView } from './worklist-view';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const MIN = 60_000;

const ROWS = parseWaitingChats([
  {
    conversation_id: 'c-old',
    contact_name: 'Mariam',
    contact_phone: '971501111111',
    assigned_agent_id: null,
    waiting_since: new Date(NOW - 150 * MIN).toISOString(),
    business_minutes: 0,
    unassigned: true,
  },
  {
    conversation_id: 'c-new',
    contact_name: null,
    contact_phone: '971502222222',
    assigned_agent_id: 'u-omar',
    waiting_since: new Date(NOW - 25 * MIN).toISOString(),
    business_minutes: 25,
    unassigned: false,
  },
]);

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {node}
    </NextIntlClientProvider>
  );
}

const nameOf = (id: string) => (id === 'u-omar' ? 'Omar' : null);

describe('WaitingCustomers', () => {
  it('lists the oldest first, each row opening its chat', () => {
    const html = render(
      <WaitingCustomers rows={ROWS} nameOf={nameOf} now={NOW} />
    );
    const ids = [
      ...html.matchAll(/data-testid="worklist-waiting-row" data-id="([^"]+)"/g),
    ].map((m) => m[1]);
    expect(ids).toEqual(['c-old', 'c-new']);
    expect(html).toContain('href="/inbox?c=c-old"');
    expect(html).toContain('href="/inbox?c=c-new"');
    expect(html).toContain('Customers waiting for a reply');
    expect(html).toContain('2 waiting');
  });

  it('flags unassigned in words, names the assignee, falls back to the phone', () => {
    const html = render(
      <WaitingCustomers rows={ROWS} nameOf={nameOf} now={NOW} />
    );
    expect(html).toContain('data-unassigned="true"');
    expect(html).toContain('Unassigned');
    expect(html).toContain('Omar');
    expect(html).toContain('Mariam');
    expect(html).toContain('971502222222');
  });

  it('says the wait in clock time and the business-hours part', () => {
    const html = render(
      <WaitingCustomers rows={ROWS} nameOf={nameOf} now={NOW} />
    );
    expect(html).toContain('Waiting 2 h');
    expect(html).toContain('Outside business hours so far');
    expect(html).toContain('Waiting 25 min');
    expect(html).toContain('25 min in business hours');
  });

  it('loading, empty and capped', () => {
    expect(
      render(<WaitingCustomers rows={null} nameOf={nameOf} now={NOW} />)
    ).toContain('Loading waiting customers...');
    const empty = render(
      <WaitingCustomers rows={[]} nameOf={nameOf} now={NOW} />
    );
    expect(empty).toContain('data-testid="worklist-waiting-empty"');
    expect(empty).toContain('No customers are waiting for a reply');
    expect(
      render(
        <WaitingCustomers rows={ROWS} nameOf={nameOf} now={NOW} capped={2} />
      )
    ).toContain('Showing the 2 longest waits.');
  });

  it('the worklist below takes the page’s empty wording', () => {
    const html = render(
      <WorklistView
        items={[]}
        mode="own"
        nameOf={nameOf}
        assignedTo=""
        onAssignedTo={() => undefined}
        members={[]}
        now={NOW}
        emptyLabel={en.WorklistWaiting.emptyOthers}
      />
    );
    expect(html).toContain('Nothing else needs action right now.');
    expect(html).not.toContain('Nothing needs action right now.');
  });
});
