import type { ComponentProps, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Notification } from '@/types';

// RingingCard's hooks are all mocked at the module boundary, so it runs as
// a plain function and its buttons can be pressed from the element it
// answers (node tests cannot mount a component).

const mocks = vi.hoisted(() => ({
  markRead: vi.fn(),
  openNotification: vi.fn(),
  auth: {
    activeWorkspaceId: 'ws-a',
    accountRole: 'agent',
    workspaces: [{ accountId: 'ws-b', name: 'Bank team', role: 'agent' }],
  },
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/inbox' }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/components/notifications/notifications-provider', () => ({
  useNotifications: () => mocks,
}));
vi.mock('@/components/pbx/call-provider', () => ({ useCalls: () => null }));
vi.mock('./session/meeting-session-provider', () => ({
  useActiveCall: () => null,
}));
vi.mock('./use-workspace-members', () => ({
  useWorkspaceMembers: () => ({ nameOf: () => 'Olivia Owner' }),
}));

import { MeetingInviteCardView, RingingCard } from './meeting-invite-card';

const MEETING = '3f1b2a34-0c6e-4f4e-9a55-0d8f2f6b1a11';

const row = (accountId = 'ws-a'): Notification =>
  ({
    id: 'n1',
    account_id: accountId,
    user_id: 'u1',
    type: 'meeting_invite',
    actor_user_id: 'host',
    title: 'Quick sync',
    body: 'Starting now',
    meta: { meeting_id: MEETING },
    created_at: '2026-11-05T10:00:00Z',
  }) as Notification;

function press(n: Notification) {
  const onDone = vi.fn();
  const element = RingingCard({ row: n, onDone }) as ReactElement<
    ComponentProps<typeof MeetingInviteCardView>
  >;
  return { onDone, props: element.props };
}

beforeEach(() => vi.clearAllMocks());

describe('RingingCard', () => {
  it('Join opens the lobby, which also reads the row, and closes the ring', () => {
    const { onDone, props } = press(row());
    props.onJoin();
    expect(mocks.openNotification).toHaveBeenCalledTimes(1);
    expect(mocks.openNotification).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'n1' }),
      { href: `/meetings/${MEETING}/room`, otherWorkspace: null }
    );
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('Not now reads the row, which closes other tabs, and opens nothing', () => {
    const { onDone, props } = press(row());
    props.onDismiss();
    expect(mocks.markRead).toHaveBeenCalledWith('n1');
    expect(mocks.openNotification).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('names who invited in the active workspace', () => {
    const { props } = press(row());
    expect(props.inviter).toBe('Olivia Owner');
    expect(props.workspace).toBeNull();
  });

  it('an invite from another workspace names it, and Join switches there', () => {
    const { props } = press(row('ws-b'));
    expect(props.inviter).toBeNull();
    expect(props.workspace).toBe('Bank team');

    props.onJoin();
    expect(mocks.openNotification).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'n1' }),
      {
        href: `/meetings/${MEETING}/room`,
        otherWorkspace: { accountId: 'ws-b', name: 'Bank team' },
      }
    );
  });
});
