import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The phone menu (the sidebar as a drawer) is slid off screen when
// closed, which hides it from the eye but not from Tab or a screen
// reader. A closed drawer must carry `inert`; an open one must not.
// useMediaQuery is false on the server, i.e. "not a phone": the drawer
// turns inert only once the client knows it is on a phone.

const mocks = vi.hoisted(() => ({ desktop: false }));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/hooks/use-media-query', () => ({
  useMediaQuery: (query: string) =>
    query.includes('max-width') ? !mocks.desktop : mocks.desktop,
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    profile: null,
    profileLoading: true,
    account: null,
    accountRole: null,
    signOut: vi.fn(),
    workspaces: [],
    activeWorkspaceId: null,
    switchWorkspace: vi.fn(),
    user: null,
    isBankGuest: false,
    salesRestricted: false,
    reviewsAllCalls: false,
  }),
}));
vi.mock('@/components/meetings/session/meeting-session-provider', () => ({
  useActiveCall: () => null,
}));
vi.mock('@/components/layout/unread-chats-provider', () => ({
  useSharedUnreadChats: () => ({ inbox: 0, teamInbox: 0 }),
}));
vi.mock('@/hooks/use-cases-overdue', () => ({ useCasesOverdue: () => 0 }));
vi.mock('@/hooks/use-groups-unread', () => ({ useGroupsUnread: () => 0 }));
vi.mock('@/hooks/use-submission-groups-unread', () => ({
  useSubmissionGroupsUnread: () => 0,
}));
vi.mock('@/hooks/use-chat-unread-total', () => ({
  useChatUnreadTotal: () => 0,
}));
vi.mock('@/hooks/use-calls-nav', () => ({
  useCallsNav: () => ({ visible: false }),
}));
vi.mock('@/hooks/use-report-nav', () => ({ useReportNav: () => [] }));
vi.mock('@/hooks/use-brain-nav', () => ({ useBrainNav: () => false }));
vi.mock('@/hooks/use-hr-team-nav', () => ({ useHrTeamNav: () => null }));
vi.mock('@/hooks/use-hr-counts', () => ({ useHrCounts: () => null }));

import { Sidebar } from './sidebar';

function render(open: boolean, desktop = false) {
  mocks.desktop = desktop;
  return renderToStaticMarkup(<Sidebar open={open} />);
}

describe('Sidebar drawer', () => {
  it('is inert (and so is its backdrop) while closed on a phone', () => {
    const html = render(false);
    expect(html).toMatch(/<aside[^>]*\sinert=""/);
    expect(html).toMatch(/<button[^>]*\sinert=""/);
  });

  it('is not inert while open', () => {
    const html = render(true);
    expect(html).not.toMatch(/\sinert/);
  });

  it('is never inert on a desktop, where it is always on screen', () => {
    const html = render(false, true);
    expect(html).not.toMatch(/<aside[^>]*\sinert/);
  });

  it('keeps sliding the other way in Arabic when closed', () => {
    expect(render(false)).toContain('max-lg:rtl:translate-x-full');
  });
});
