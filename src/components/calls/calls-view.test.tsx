import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, createTranslator } from 'next-intl';

import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';
import type { AccountRole } from '@/lib/auth/roles';
import { UNROUTED_SUMMARY_DAYS, type CallsTab } from '@/lib/pbx/call-ui';

// The node environment cannot mount the screen or run its effects, so
// this pins what a role sees on first render for a given ?tab=, and the
// words that tell an admin how far back the Unrouted numbers reach. The
// rules themselves live in lib/pbx/call-ui and the list route.

const mocks = vi.hoisted(() => ({ role: null as AccountRole | null }));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountRole: mocks.role }),
}));
vi.mock('@/components/calls/call-report', () => ({
  CallReport: () => 'by-person-report',
}));
vi.mock('@/components/chat/share-to-chat-dialog', () => ({
  ShareCallButton: () => null,
}));
vi.mock('@/components/pbx/call-button', () => ({ CallButton: () => null }));

import { CallsView } from './calls-view';

function render(tab: CallsTab, role: AccountRole | null): string {
  mocks.role = role;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <CallsView tab={tab} />
    </NextIntlClientProvider>
  );
}

const missedHint = en.CallsPage.missedHint;
const mineHint = en.CallsPage.mineHint;
const unroutedHint = en.CallsPage.unrouted.hint;

describe('CallsView', () => {
  it('shows My calls, not a failed load, to a role opening Unrouted by link', () => {
    for (const role of ['team_leader', 'agent', 'viewer'] as const) {
      const html = render('unrouted', role);
      expect(html).toContain(mineHint);
      expect(html).not.toContain(unroutedHint);
    }
  });

  it('shows My calls to a role opening By person or Team calls by link', () => {
    for (const role of ['agent', 'viewer'] as const) {
      expect(render('log', role)).toContain(mineHint);
      const html = render('people', role);
      expect(html).toContain(mineHint);
      expect(html).not.toContain('by-person-report');
    }
  });

  it('shows the tab asked for to a role that is offered it', () => {
    for (const role of ['admin', 'owner'] as const) {
      const html = render('unrouted', role);
      expect(html).toContain(unroutedHint);
      expect(html).not.toContain(missedHint);
    }
    expect(render('people', 'team_leader')).toContain('by-person-report');
    expect(render('missed', 'agent')).toContain(missedHint);
  });

  it('opens on My calls, and offers the supervisor tab by role', () => {
    const tabs = en.CallsPage.tabs;
    const agent = render('mine', 'agent');
    expect(agent).toContain(mineHint);
    expect(agent).toContain(tabs.mine);
    expect(agent).not.toContain(tabs.team);
    expect(agent).not.toContain(tabs.all);
    expect(render('mine', 'team_leader')).toContain(tabs.team);
    expect(render('mine', 'admin')).toContain(tabs.all);
  });

  it('offers the Mine / Team|All toggle on Missed calls to leaders and admins only', () => {
    const who = en.CallsPage.missedWho;
    for (const role of ['agent', 'viewer', null] as const)
      expect(render('missed', role)).not.toContain(who.label);
    const leader = render('missed', 'team_leader');
    expect(leader).toContain(who.label);
    expect(leader).toContain(`>${who.team}<`);
    expect(leader).not.toContain(`>${who.all}<`);
    expect(render('missed', 'owner')).toContain(`>${who.all}<`);
  });
});

describe('the Unrouted numbers’ window', () => {
  it('is worded with the days the list route reads, in English and Korean', () => {
    for (const [locale, messages] of [
      ['en', en],
      ['ko', ko],
    ] as const) {
      const say = createTranslator({
        locale,
        messages,
        namespace: 'CallsPage',
      });
      expect(
        say('unrouted.numbersWindow', { days: UNROUTED_SUMMARY_DAYS })
      ).toContain(String(UNROUTED_SUMMARY_DAYS));
    }
  });
});
