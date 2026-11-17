import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ACCOUNT_ROLES, type AccountRole } from '@/lib/auth/roles';
import {
  BOTTOM_NAV_ITEMS,
  NAV_GROUPS,
  isNavItemActive,
  isNavItemVisible,
  navPrefetch,
  visibleBottomNavItems,
  visibleNavGroups,
  visibleNavItems,
  type NavGroup,
} from './nav-items';

/** Group id → hrefs, the shape a reader would check the sidebar by. */
function layout(groups: NavGroup[]): Record<string, string[]> {
  return Object.fromEntries(
    groups.map((g) => [g.id, g.items.map((item) => item.href)])
  );
}

/** Every staff role's groups: the rows no role gates. */
const VIEWER = {
  main: ['/dashboard'],
  conversations: ['/inbox', '/groups'],
  customers: ['/contacts', '/pipelines'],
  collaboration: ['/chat', '/meetings', '/calendar'],
};

/** An agent and up: Journeys (module 016) and Bank submissions are agent+. */
const AGENT = {
  ...VIEWER,
  customers: [...VIEWER.customers, '/journeys'],
  submissions: ['/cases', '/submission-groups', '/banks'],
};

const TEAM = [
  '/team-inbox',
  '/team-contacts',
  '/team-activity',
  '/my-activity',
];

/** An agent's own figures: the one team-group row below team leader. */
const SELF = ['/my-activity'];

/** The HR group (migration 200), as an owner or admin sees it. */
const HR_ALL = [
  '/hr/recruiter',
  '/hr/department',
  '/hr/unsorted',
  '/hr/tasks',
  '/hr/rules',
  '/hr/hire-fast',
  '/hr/automated-messages',
];

/**
 * The source of the nearest layout on `href`'s path, '' for none: the
 * HR screens share /hr/layout.tsx.
 */
function routeLayout(appDir: string, href: string): string {
  const parts = href.slice(1).split('/');
  const file = parts
    .map((_, i) =>
      join(appDir, ...parts.slice(0, parts.length - i), 'layout.tsx')
    )
    .find((f) => existsSync(f));
  return file ? readFileSync(file, 'utf8') : '';
}

const ALL_ITEMS = [...NAV_GROUPS.flatMap((g) => g.items), ...BOTTOM_NAV_ITEMS];

describe('visibleNavGroups', () => {
  it.each([
    [null, VIEWER],
    ['viewer', VIEWER],
    ['agent', { ...AGENT, team: SELF }],
  ] as const)(
    'gives %s its groups, with no team-wide or admin views',
    (role, groups) => {
      expect(layout(visibleNavGroups(role))).toEqual(groups);
    }
  );

  it('adds the team views and Team activity for a team leader', () => {
    expect(layout(visibleNavGroups('team_leader'))).toEqual({
      ...AGENT,
      team: TEAM,
    });
  });

  it.each(['admin', 'owner'] as const)('shows %s every group', (role) => {
    expect(layout(visibleNavGroups(role))).toEqual({
      ...AGENT,
      team: TEAM,
      hr: HR_ALL,
      automation: ['/broadcasts', '/automations', '/flows'],
      integrations: ['/compass', '/opendesk'],
    });
  });

  it("orders the groups by area, the higher roles' views last", () => {
    expect(visibleNavGroups('owner').map((g) => g.id)).toEqual([
      'main',
      'collaboration',
      'conversations',
      'customers',
      'submissions',
      'team',
      'hr',
      'automation',
      'integrations',
    ]);
  });

  it('shows a bank guest team chat and nothing else', () => {
    expect(layout(visibleNavGroups('bank_guest'))).toEqual({
      collaboration: ['/chat'],
    });
    expect(visibleBottomNavItems('bank_guest')).toEqual([]);
  });

  it('adds Calls after the inbox for staff once the phone system is in use', () => {
    for (const role of [
      'viewer',
      'agent',
      'team_leader',
      'admin',
      'owner',
    ] as const)
      expect(
        layout(visibleNavGroups(role, { pbx: true })).conversations,
        role
      ).toEqual(['/inbox', '/calls', '/groups']);
  });

  it('hides Calls with no phone system, from a bank guest, and while the role loads', () => {
    for (const role of [null, ...ACCOUNT_ROLES])
      expect(
        visibleNavGroups(role).flatMap((g) => g.items.map((i) => i.href)),
        String(role)
      ).not.toContain('/calls');
    expect(layout(visibleNavGroups('bank_guest', { pbx: true }))).toEqual({
      collaboration: ['/chat'],
    });
    expect(layout(visibleNavGroups(null, { pbx: true }))).toEqual(VIEWER);
  });

  it('shows Brain to agents and up only while the workspace has it on', () => {
    for (const role of [null, ...ACCOUNT_ROLES])
      expect(
        visibleNavGroups(role, { pbx: true }).flatMap((g) =>
          g.items.map((i) => i.href)
        ),
        String(role)
      ).not.toContain('/brain');
    for (const role of ['agent', 'team_leader', 'admin', 'owner'] as const)
      expect(
        layout(visibleNavGroups(role, { brain: true })).submissions,
        role
      ).toEqual([
        '/cases',
        '/submission-groups',
        '/banks',
        '/brain',
        '/digest',
      ]);
    for (const role of [null, 'viewer', 'bank_guest'] as const)
      expect(
        visibleNavGroups(role, { brain: true }).flatMap((g) =>
          g.items.map((i) => i.href)
        ),
        String(role)
      ).not.toContain('/brain');
    expect(
      visibleNavGroups('agent', { brain: true, salesRestricted: true }).flatMap(
        (g) => g.items.map((i) => i.href)
      )
    ).not.toContain('/brain');
  });

  it('gates the Daily digest exactly like Brain', () => {
    const hrefs = (
      role: AccountRole | null,
      ctx: Parameters<typeof visibleNavGroups>[1]
    ) => visibleNavGroups(role, ctx).flatMap((g) => g.items.map((i) => i.href));
    for (const role of [null, ...ACCOUNT_ROLES])
      expect(hrefs(role, { pbx: true }), String(role)).not.toContain('/digest');
    for (const role of [null, 'viewer', 'bank_guest'] as const)
      expect(hrefs(role, { brain: true }), String(role)).not.toContain(
        '/digest'
      );
    expect(
      hrefs('agent', { brain: true, salesRestricted: true })
    ).not.toContain('/digest');
    expect(hrefs('agent', { brain: true })).toContain('/digest');
  });

  it('shows Team recordings to a call reviewer below team leader (198)', () => {
    const hrefs = (
      role: AccountRole | null,
      ctx: Parameters<typeof visibleNavGroups>[1]
    ) => visibleNavGroups(role, ctx).flatMap((g) => g.items.map((i) => i.href));
    for (const role of ['viewer', 'agent'] as const) {
      expect(hrefs(role, { pbx: true }), role).not.toContain(
        '/calls/recordings'
      );
      expect(hrefs(role, { pbx: true, callReviewer: true }), role).toContain(
        '/calls/recordings'
      );
      // The phone system still has to be in use.
      expect(hrefs(role, { callReviewer: true }), role).not.toContain(
        '/calls/recordings'
      );
    }
    // Never a guest, nor while the role loads.
    for (const role of [null, 'bank_guest'] as const)
      expect(
        hrefs(role, { pbx: true, callReviewer: true }),
        String(role)
      ).not.toContain('/calls/recordings');
    // The flag waives only the Team recordings row's role floor.
    expect(hrefs('agent', { pbx: true, callReviewer: true })).not.toContain(
      '/team-inbox'
    );
  });

  describe('the HR group (200)', () => {
    const hrRows = (
      role: AccountRole | null,
      ctx: Parameters<typeof visibleNavGroups>[1]
    ) =>
      visibleNavGroups(role, ctx)
        .find((g) => g.id === 'hr')
        ?.items.map((i) => i.href) ?? [];
    const roles = (
      recruiter: 'lead' | 'member' | null,
      dept: 'lead' | 'member' | null
    ) => ({ admin: false, recruiter, dept });

    it('shows an admin every HR screen, roles known or not', () => {
      expect(hrRows('admin', {})).toEqual(HR_ALL);
      expect(hrRows('owner', { hrRoles: null })).toEqual(HR_ALL);
    });

    it('shows a recruiter lead the recruitment screens, not HR department', () => {
      expect(hrRows('agent', { hrRoles: roles('lead', null) })).toEqual([
        '/hr/recruiter',
        '/hr/unsorted',
        '/hr/tasks',
        '/hr/rules',
        '/hr/hire-fast',
        '/hr/automated-messages',
      ]);
    });

    it('shows a recruiter member Hire fast but not Automated messages', () => {
      expect(hrRows('agent', { hrRoles: roles('member', null) })).toEqual([
        '/hr/recruiter',
        '/hr/unsorted',
        '/hr/tasks',
        '/hr/rules',
        '/hr/hire-fast',
      ]);
    });

    it('shows a dept member no Recruiter HR and no Hire fast', () => {
      expect(hrRows('agent', { hrRoles: roles(null, 'member') })).toEqual([
        '/hr/department',
        '/hr/unsorted',
        '/hr/tasks',
        '/hr/rules',
      ]);
      // A dept lead leads no recruitment: still no Automated messages.
      expect(hrRows('agent', { hrRoles: roles(null, 'lead') })).not.toContain(
        '/hr/automated-messages'
      );
    });

    it('keeps the HR rows for a restricted department (HR people are one)', () => {
      expect(
        hrRows('agent', {
          hrRoles: roles(null, 'member'),
          salesRestricted: true,
        })
      ).toContain('/hr/department');
    });

    it('hides the group from staff with no HR role, a guest and a loading role', () => {
      expect(hrRows('agent', {})).toEqual([]);
      expect(hrRows('team_leader', { hrRoles: roles(null, null) })).toEqual([]);
      for (const role of [null, 'bank_guest'] as const)
        expect(
          hrRows(role, { hrRoles: roles('lead', 'lead') }),
          String(role)
        ).toEqual([]);
    });

    it('opens nothing outside the HR group', () => {
      const all = visibleNavGroups('agent', { hrRoles: roles('lead', 'lead') });
      expect(layout(all)).toEqual({ ...AGENT, team: SELF, hr: HR_ALL });
    });
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

  it('heads every group but the home row', () => {
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
      const source = routeLayout(appDir, item.href);
      // CallReviewerLayout is team leader and up, plus a call reviewer
      // (migration 198), whom `callReviewerVisible` lets past minRole.
      const reviewerGuard = source.includes('CallReviewerLayout');
      expect(!!item.callReviewerVisible, item.href).toBe(reviewerGuard);
      // HrAccessLayout is admin and up, plus anyone with an HR role
      // (migration 200): an `hr` row, gated by hrGateOpen, not minRole.
      const hrGuard = source.includes('HrAccessLayout');
      expect(!!item.hr, item.href).toBe(hrGuard);
      const guard: AccountRole | undefined =
        source.includes('TeamLeaderOnlyLayout') || reviewerGuard
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

  // A guarded route is dynamic, so only a full prefetch saves the click
  // its round trip. A row marked guarded with no guard (or a guard the
  // row does not know about) drifts the prefetch away from the route.
  it("marks a row guarded exactly when its route's layout guards it", () => {
    const appDir = join(process.cwd(), 'src', 'app', '(dashboard)');
    for (const item of ALL_ITEMS) {
      const source = routeLayout(appDir, item.href);
      const guarded =
        /\b(Admin|TeamLeader|Agent|Staff)OnlyLayout\b/.test(source) ||
        /\b(CallReviewer|HrAccess)Layout\b/.test(source);
      expect(!!item.guarded, item.href).toBe(guarded);
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

describe('navPrefetch', () => {
  it('fully prefetches the guarded routes and leaves the rest on auto', () => {
    const full = ALL_ITEMS.filter((item) => navPrefetch(item) === true).map(
      (item) => item.href
    );
    expect(full.sort()).toEqual(
      [
        '/automations',
        '/banks',
        '/brain',
        '/digest',
        '/broadcasts',
        '/calendar',
        '/calls',
        '/calls/recordings',
        '/cases',
        '/compass',
        '/flows',
        '/groups',
        ...HR_ALL,
        '/journeys',
        '/meetings',
        '/my-activity',
        '/opendesk',
        '/submission-groups',
        '/team-activity',
        '/team-contacts',
        '/team-inbox',
      ].sort()
    );
    for (const item of ALL_ITEMS) {
      if (!item.guarded) expect(navPrefetch(item), item.href).toBeNull();
    }
  });
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

describe('visibleNavItems / sales-restricted departments', () => {
  const items = [
    { href: '/inbox' },
    { href: '/contacts' },
    { href: '/contacts/123' },
    { href: '/cases' },
    { href: '/team-inbox' },
    { href: '/chat' },
  ];

  it('drops restricted paths only for a restricted person', () => {
    expect(
      visibleNavItems(items, { salesRestricted: true }).map((i) => i.href)
    ).toEqual(['/inbox', '/contacts', '/contacts/123', '/team-inbox', '/chat']);
    expect(visibleNavItems(items, { salesRestricted: false })).toEqual(items);
  });

  it('hides the sidebar rows through visibleNavGroups', () => {
    const hrefs = (restricted: boolean) =>
      visibleNavGroups('team_leader', { salesRestricted: restricted }).flatMap(
        (g) => g.items.map((i) => i.href)
      );
    expect(hrefs(false)).toContain('/pipelines');
    expect(hrefs(true)).not.toContain('/pipelines');
    expect(hrefs(true)).toContain('/contacts');
    expect(hrefs(true)).not.toContain('/team-contacts');
    expect(hrefs(true)).toContain('/inbox');
    // A restricted (HR) team leader still follows her team.
    expect(hrefs(true)).toContain('/team-inbox');
  });
});
