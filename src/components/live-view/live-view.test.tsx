/**
 * The Live view's pure render, server-side (no DOM in the test env):
 * a row per person in the order given, status as icon and word, the
 * figures, the oldest wait in words, the admin's unassigned count, and
 * the loading, error and empty states. Both layouts are in the markup
 * (cards below `sm`, a table above), so each person appears twice.
 */
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';
import { parseLiveTeamView } from '@/lib/live-view/view';

import { LiveView, type LiveViewProps } from './live-view';

const NOW = Date.parse('2026-11-22T12:00:00Z');

const VIEW = parseLiveTeamView({
  people: [
    {
      user_id: 'u-omar',
      name: 'Omar',
      role: 'agent',
      presence: 'online',
      open_chats: 7,
      waiting_chats: 2,
      oldest_waiting_since: '2026-11-22T11:35:00Z',
      oldest_waiting_business_minutes: 25,
      replies_today: 31,
    },
    {
      user_id: 'u-layla',
      name: 'Layla',
      role: 'team_leader',
      presence: 'offline',
      open_chats: 0,
      waiting_chats: 0,
      oldest_waiting_since: null,
      replies_today: 0,
    },
  ],
  unassigned_waiting: 3,
  timezone: 'Asia/Dubai',
  scope: 'all',
});

function render(over: Partial<LiveViewProps> = {}) {
  const props: LiveViewProps = {
    view: VIEW,
    error: null,
    now: NOW,
    updatedLabel: '12:00',
    refreshing: false,
    onRefresh: () => undefined,
    ...over,
  };
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <LiveView {...props} />
    </NextIntlClientProvider>
  );
}

describe('LiveView', () => {
  it('renders each person as a table row and a phone card', () => {
    const html = render();
    const rows = [
      ...html.matchAll(/data-testid="live-row" data-id="([^"]+)"/g),
    ].map((m) => m[1]);
    const cards = [
      ...html.matchAll(/data-testid="live-card" data-id="([^"]+)"/g),
    ].map((m) => m[1]);
    expect(rows).toEqual(['u-omar', 'u-layla']);
    expect(cards).toEqual(rows);
    expect(html).not.toContain('<h1');
  });

  it('shows status in words, the figures and the oldest wait', () => {
    const html = render();
    expect(html).toContain('data-presence="online"');
    expect(html).toContain('Online');
    expect(html).toContain('Offline');
    expect(html).toContain('Team leader');
    expect(html).toContain('>31<');
    expect(html).toContain('25 min');
    expect(html).toContain('25 min in business hours');
    expect(html).toContain('None waiting');
    expect(html).toContain('Replies today count from midnight (Asia/Dubai)');
    expect(html).toContain('Updated 12:00');
  });

  it('shows the unassigned count to an admin only', () => {
    expect(render()).toContain('3 unassigned customers are waiting');
    const team = parseLiveTeamView({ people: [], scope: 'team' });
    expect(render({ view: team })).not.toContain(
      'data-testid="live-unassigned"'
    );
  });

  it('loading, empty and errors', () => {
    expect(render({ view: null })).toContain('Loading the live view...');
    expect(
      render({ view: parseLiveTeamView({ people: [], scope: 'team' }) })
    ).toContain('Nobody to show yet');
    expect(render({ view: null, error: 'not_allowed' })).toContain(
      'Only team leaders, admins and owners can open the live view.'
    );
    const failed = render({ error: 'failed' });
    expect(failed).toContain('could not be loaded');
    // A failed refresh keeps the last figures.
    expect(failed).toContain('data-testid="live-row"');
  });

  it('shows the team filter only when there are teams to pick', () => {
    expect(render()).not.toContain('data-testid="live-team-filter"');
    const teams = [
      { id: 't1', name: 'Sales', leaderUserId: 'u-layla', memberIds: [] },
    ];
    const leader = render({ teams, onTeamChange: () => undefined });
    expect(leader).toContain('data-testid="live-team-filter"');
    expect(leader).toContain('All my teams');
    expect(leader).toContain('>Sales<');
    const admin = render({
      teams,
      onTeamChange: () => undefined,
      canPickAnyTeam: true,
    });
    expect(admin).toContain('All teams');
  });
});
