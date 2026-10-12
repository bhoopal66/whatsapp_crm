import { describe, expect, it } from 'vitest';

import {
  fallbackWorkspace,
  guestRedirectPath,
  isGuestPath,
  parseMyWorkspaces,
  workspaceHomePath,
  type Workspace,
} from './my-workspaces';

function ws(accountId: string, over: Partial<Workspace> = {}): Workspace {
  return {
    accountId,
    name: accountId,
    shortName: null,
    role: 'agent',
    isActive: false,
    deactivated: false,
    ...over,
  };
}

describe('parseMyWorkspaces', () => {
  it('maps my_workspaces() rows to the REST shape, keeping their order', () => {
    expect(
      parseMyWorkspaces([
        {
          account_id: 'credit',
          name: 'Taamul Credit',
          short_name: 'TC',
          role: 'admin',
          is_active: true,
          deactivated: false,
        },
        {
          account_id: 'bank',
          name: 'TrafeeqPay',
          short_name: 'TP',
          role: 'bank_guest',
          is_active: false,
          deactivated: true,
        },
      ])
    ).toEqual([
      {
        accountId: 'credit',
        name: 'Taamul Credit',
        shortName: 'TC',
        role: 'admin',
        isActive: true,
        deactivated: false,
      },
      {
        accountId: 'bank',
        name: 'TrafeeqPay',
        shortName: 'TP',
        role: 'bank_guest',
        isActive: false,
        deactivated: true,
      },
    ]);
  });

  it('reads anything but a list as no workspaces', () => {
    expect(parseMyWorkspaces(null)).toEqual([]);
    expect(parseMyWorkspaces({ message: 'function not found' })).toEqual([]);
  });

  it('drops a row without an account id and narrows unknown values', () => {
    const [only, ...rest] = parseMyWorkspaces([
      { name: 'orphan' },
      { account_id: 'a', role: 'superuser', short_name: '  ', is_active: 't' },
    ]);
    expect(rest).toEqual([]);
    expect(only).toEqual({
      accountId: 'a',
      name: '',
      shortName: null,
      role: null,
      isActive: false,
      deactivated: false,
    });
  });
});

describe('fallbackWorkspace', () => {
  it('moves a person out of a deactivated workspace into an open one', () => {
    const list = [
      ws('credit', { isActive: true, deactivated: true }),
      ws('pay'),
    ];
    expect(fallbackWorkspace(list, 'credit')?.accountId).toBe('pay');
  });

  it('never picks the deactivated active workspace, wherever it sits', () => {
    const list = [
      ws('alpha'),
      ws('credit', { isActive: true, deactivated: true }),
    ];
    expect(fallbackWorkspace(list, 'credit')?.accountId).toBe('alpha');
  });

  it('skips other deactivated memberships and takes the first open one', () => {
    const list = [
      ws('credit', { isActive: true, deactivated: true }),
      ws('b', { deactivated: true }),
      ws('c', { role: 'bank_guest' }),
      ws('d'),
    ];
    expect(fallbackWorkspace(list, 'credit')?.accountId).toBe('c');
  });

  it('returns null when every membership is deactivated (sign out)', () => {
    const list = [
      ws('credit', { isActive: true, deactivated: true }),
      ws('b', { deactivated: true }),
    ];
    expect(fallbackWorkspace(list, 'credit')).toBeNull();
  });

  it('returns null with no list (my_workspaces unavailable before 083)', () => {
    expect(fallbackWorkspace([], 'credit')).toBeNull();
  });
});

describe('workspaceHomePath', () => {
  it('lands a bank guest on team chat and staff on the dashboard', () => {
    expect(workspaceHomePath('bank_guest')).toBe('/chat');
    expect(workspaceHomePath('viewer')).toBe('/dashboard');
    expect(workspaceHomePath('owner')).toBe('/dashboard');
    expect(workspaceHomePath(null)).toBe('/dashboard');
  });
});

describe('guest paths', () => {
  it('treats /chat and its subpaths as the guest area, on whole segments', () => {
    expect(isGuestPath('/chat')).toBe(true);
    expect(isGuestPath('/chat/room-1')).toBe(true);
    expect(isGuestPath('/chatter')).toBe(false);
    expect(isGuestPath('/dashboard')).toBe(false);
  });

  it('sends a guest anywhere outside /chat back to /chat', () => {
    for (const path of ['/dashboard', '/inbox', '/settings', '/tasks', '/']) {
      expect(guestRedirectPath('bank_guest', path)).toBe('/chat');
    }
    expect(guestRedirectPath('bank_guest', '/chat')).toBeNull();
    expect(guestRedirectPath('bank_guest', '/chat/room-1')).toBeNull();
  });

  it('leaves staff, and a role still loading, where they are', () => {
    expect(guestRedirectPath('agent', '/inbox')).toBeNull();
    expect(guestRedirectPath('viewer', '/chat')).toBeNull();
    expect(guestRedirectPath(null, '/inbox')).toBeNull();
  });
});
