import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The shell keeps a bank guest on /chat (migrations 082/083). The
// redirect itself runs in an effect, which server rendering does not
// run; what this pins is the other half — nothing of the screen a guest
// is being moved off renders meanwhile — and that staff, and anyone
// whose role is still loading, are not held back.

const mocks = vi.hoisted(() => ({
  pathname: '/dashboard',
  auth: {
    user: { id: 'u1' } as unknown,
    loading: false,
    profileLoading: false,
    accountRole: 'agent' as string | null,
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => mocks.pathname,
}));
vi.mock('@/hooks/use-auth', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => mocks.auth,
}));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/header', () => ({ Header: () => null }));
vi.mock('@/components/layout/account-access-alert', () => ({
  AccountAccessAlert: () => null,
}));
vi.mock('@/components/layout/push-prompt', () => ({ PushPrompt: () => null }));
vi.mock('@/components/presence/presence-heartbeat', () => ({
  PresenceHeartbeat: () => null,
}));
// The call layer (migration 089) opens a Supabase client; it is a
// module boundary here like the sidebar and header.
vi.mock('@/components/pbx/call-provider', () => ({
  CallProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/pbx/incoming-call-card', () => ({
  IncomingCallCard: () => null,
}));
vi.mock('@/components/pbx/in-call-panel', () => ({ InCallPanel: () => null }));
vi.mock('@/components/pbx/softphone-mount', () => ({
  SoftphoneMount: () => null,
}));
vi.mock('@/components/context-menu/app-context-menu', () => ({
  AppContextMenu: () => null,
}));

import { DashboardShell } from './dashboard-shell';

function render(role: string | null, pathname: string, profileLoading = false) {
  mocks.auth.accountRole = role;
  mocks.auth.profileLoading = profileLoading;
  mocks.pathname = pathname;
  return renderToStaticMarkup(
    React.createElement(DashboardShell, null, 'PAGE')
  );
}

describe('DashboardShell guest gating', () => {
  beforeEach(() => {
    mocks.auth.user = { id: 'u1' };
    mocks.auth.loading = false;
  });

  it('renders nothing of another screen for a bank guest', () => {
    expect(render('bank_guest', '/dashboard')).not.toContain('PAGE');
    expect(render('bank_guest', '/inbox')).not.toContain('PAGE');
  });

  it('renders Settings for a bank guest, where they switch workspace', () => {
    expect(render('bank_guest', '/settings')).toContain('PAGE');
  });

  it('renders team chat for a bank guest', () => {
    expect(render('bank_guest', '/chat')).toContain('PAGE');
    expect(render('bank_guest', '/chat/room-1')).toContain('PAGE');
  });

  it('renders every screen for staff', () => {
    expect(render('agent', '/inbox')).toContain('PAGE');
    expect(render('viewer', '/chat')).toContain('PAGE');
  });

  it('does not hold a page back while the role is still loading', () => {
    expect(render(null, '/inbox', true)).toContain('PAGE');
  });
});
