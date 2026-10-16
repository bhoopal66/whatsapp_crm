import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ACCOUNT_ROLES, type AccountRole } from '@/lib/auth/roles';
import {
  BOTTOM_NAV_ITEMS,
  NAV_GROUPS,
  isNavItemActive,
  isNavItemVisible,
  visibleBottomNavItems,
  visibleNavGroups,
  type NavGroup,
} from './nav-items';

/** Group id → hrefs, the shape a reader would check the sidebar by. */
function layout(groups: NavGroup[]): Record<string, string[]> {
  return Object.fromEntries(
    groups.map((g) => [g.id, g.items.map((item) => item.href)])
  );
}

const EVERYONE = [
  '/dashboard',
  '/notifications',
  '/inbox',
  '/groups',
  '/chat',
  '/meetings',
  '/calendar',
  '/contacts',
  '/pipelines',
];

/** The opening group for an agent and up: Journeys (module 016) is agent+. */
const STAFF = [
  ...EVERYONE.slice(0, 4),
  '/submission-groups',
  ...EVERYONE.slice(4),
  '/journeys',
];

const ALL_ITEMS = [...NAV_GROUPS.flatMap((g) => g.items), ...BOTTOM_NAV_ITEMS];

describe('visibleNavGroups', () => {
  it.each([
    [null, EVERYONE],
    ['viewer', EVERYONE],
    ['agent', STAFF],
  ] as const)(
    'gives %s only the opening group, with no heading',
    (role, main) => {
      const groups = visibleNavGroups(role);
      expect(layout(groups)).toEqual({ main });
      expect(groups.every((g) => g.labelKey === null)).toBe(true);
    }
  );

  it('adds the team views and Team activity for a team leader', () => {
    expect(layout(visibleNavGroups('team_leader'))).toEqual({
      main: STAFF,
      team: ['/team-inbox', '/team-contacts', '/team-activity'],
    });
  });

  it.each(['admin', 'owner'] as const)('shows %s every group', (role) => {
    expect(layout(visibleNavGroups(role))).toEqual({
      main: STAFF,
      team: ['/team-inbox', '/team-contacts', '/team-activity'],
      sales: ['/broadcasts'],
      automation: ['/automations', '/flows'],
      integrations: ['/compass'],
    });
  });

  it('shows a bank guest team chat and nothing else', () => {
    expect(layout(visibleNavGroups('bank_guest'))).toEqual({ main: ['/chat'] });
    expect(visibleBottomNavItems('bank_guest')).toEqual([]);
  });

  it('adds Calls after the inbox for staff once the phone system is in use', () => {
    const withCalls = (main: string[]) => [
      ...main.slice(0, 3),
      '/calls',
      ...main.slice(3),
    ];
    expect(layout(visibleNavGroups('viewer', { pbx: true })).main).toEqual(
      withCalls(EVERYONE)
    );
    for (const role of ['agent', 'team_leader', 'admin', 'owner'] as const)
      expect(layout(visibleNavGroups(role, { pbx: true })).main, role).toEqual(
        withCalls(STAFF)
      );
  });

  it('hides Calls with no phone system, from a bank guest, and while the role loads', () => {
    for (const role of [null, ...ACCOUNT_ROLES])
      expect(
        visibleNavGroups(role).flatMap((g) => g.items.map((i) => i.href)),
        String(role)
      ).not.toContain('/calls');
    expect(layout(visibleNavGroups('bank_guest', { pbx: true }))).toEqual({
      main: ['/chat'],
    });
    expect(layout(visibleNavGroups(null, { pbx: true })).main).toEqual(
      EVERYONE
    );
  });

  it('shows a guestVisible row to a guest and to staff alike', () => {
    const chat = {
      href: '/chat',
      labelKey: 'chat',
      icon: ALL_ITEMS[0].icon,
      guestVisible: true,
    };
    expect(isNavItemVisible(chat, 'bank_guest')).toBe(true);
    expect(isNavItemVisible(chat, 'viewer')).toBe(true);
    expect(isNavItemVisible({ ...chat, minRole: 'admin' }, 'agent')).toBe(
      false
    );
  });

  it('keeps Settings for every staff role, and while loading', () => {
    for (const role of [
      null,
      'viewer',
      'agent',
      'team_leader',
      'admin',
      'owner',
    ] as const) {
      expect(
        visibleBottomNavItems(role).map((i) => i.href),
        String(role)
      ).toEqual(['/settings']);
    }
  });

  it.each([null, ...ACCOUNT_ROLES])('never hands %s an empty group', (role) => {
    for (const group of visibleNavGroups(role)) {
      expect(group.items.length, group.id).toBeGreaterThan(0);
    }
  });

  it('leaves only the opening group without a heading', () => {
    expect(
      NAV_GROUPS.filter((g) => g.labelKey === null).map((g) => g.id)
    ).toEqual(['main']);
    expect(NAV_GROUPS[0].id).toBe('main');
  });
});

describe('nav model', () => {
  it('lists every destination once', () => {
    const hrefs = ALL_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  // The sidebar only hides rows; each route's own layout is the guard.
  // If the two drift, a role is shown a link that bounces it, or the
  // row is hidden from someone the route would let in.
  it("gates each row exactly as its route's layout does", () => {
    const appDir = join(process.cwd(), 'src', 'app', '(dashboard)');
    for (const item of ALL_ITEMS) {
      const file = join(appDir, item.href.slice(1), 'layout.tsx');
      const source = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const guard: AccountRole | undefined = source.includes(
        'TeamLeaderOnlyLayout'
      )
        ? 'team_leader'
        : source.includes('AdminOnlyLayout')
          ? 'admin'
          : source.includes('AgentOnlyLayout')
            ? 'agent'
            : undefined;
      expect(item.minRole, item.href).toBe(guard);
      // A staff-only route turns a bank guest away: never show one its row.
      if (source.includes('StaffOnlyLayout'))
        expect(item.guestVisible, item.href).toBeFalsy();
    }
  });

  // /calls had no guard: a bank guest who typed the URL got the screen
  // (its API answered 403, but the page was theirs to open).
  it.each(['calls', 'groups', 'meetings', 'calendar'])(
    'turns a bank guest away from /%s on the server',
    (route) => {
      const file = join(process.cwd(), 'src', 'app', '(dashboard)', route);
      const source = existsSync(join(file, 'layout.tsx'))
        ? readFileSync(join(file, 'layout.tsx'), 'utf8')
        : '';
      expect(source).toContain('StaffOnlyLayout');
    }
  );
});

describe('isNavItemActive', () => {
  it('lights a row on its own page and its sub-pages', () => {
    expect(isNavItemActive('/broadcasts', '/broadcasts')).toBe(true);
    expect(isNavItemActive('/broadcasts', '/broadcasts/new')).toBe(true);
    expect(isNavItemActive('/settings', '/settings')).toBe(true);
  });

  it('matches whole path segments only', () => {
    expect(isNavItemActive('/inbox', '/team-inbox')).toBe(false);
    expect(isNavItemActive('/contacts', '/team-contacts')).toBe(false);
    expect(isNavItemActive('/flows', '/flowsheet')).toBe(false);
  });

  it('lights the dashboard only on itself', () => {
    expect(isNavItemActive('/dashboard', '/dashboard')).toBe(true);
    expect(isNavItemActive('/dashboard', '/dashboard/anything')).toBe(false);
  });
});

const LOCALES = readdirSync(join(process.cwd(), 'messages'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

describe('sidebar labels', () => {
  it.each(LOCALES)('%s.json labels every row and heading', (locale) => {
    const raw = readFileSync(
      join(process.cwd(), 'messages', `${locale}.json`),
      'utf8'
    );
    const sidebar = JSON.parse(raw).Sidebar;
    // next-intl reads a dotted key as a path into nested objects.
    const lookup = (key: string): unknown =>
      key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown> | undefined)?.[part],
          sidebar
        );
    const keys = [
      ...NAV_GROUPS.flatMap((g) => (g.labelKey ? [g.labelKey] : [])),
      ...ALL_ITEMS.map((item) => item.labelKey),
    ];
    for (const key of keys) {
      expect(lookup(key), `missing Sidebar.${key}`).toBeTruthy();
      expect(typeof lookup(key), `Sidebar.${key}`).toBe('string');
    }
  });
});
