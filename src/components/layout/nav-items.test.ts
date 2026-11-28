import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ACCOUNT_ROLES, type AccountRole } from '@/lib/auth/roles';
import { HR_TABS, hrLandingPath, visibleHrTabs } from '@/lib/hr/tabs';
import {
  BOTTOM_NAV_ITEMS,
  NAV_GROUPS,
  NAV_PREFETCH,
  TEAM_VIEW_ITEMS,
  canUseTeamView,
  isNavItemActive,
  isNavItemVisible,
  isNavRowActive,
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
  main: ['/dashboard', '/worklist'],
  // The group wall has /groups' guards and visibility.
  conversations: ['/inbox', '/groups', '/group-wall'],
  customers: ['/contacts', '/pipelines'],
  collaboration: ['/chat', '/meetings', '/calendar'],
};

/** An agent and up: Journeys (module 016) and Bank submissions are agent+. */
const AGENT = {
  ...VIEWER,
  // My activity sits right after My worklist.
  main: ['/dashboard', '/worklist', '/my-activity'],
  customers: [...VIEWER.customers, '/journeys'],
  submissions: ['/cases', '/desk', '/submission-groups', '/banks'],
};

/** Team leader and up: Declined recycling (migration 251). */
const LEADER = {
  ...AGENT,
  submissions: ['/cases', '/desk', '/recycle', '/submission-groups', '/banks'],
};

/** Team leader and up: the team group (the Mine / Team views are no rows). */
const TEAM = ['/live', '/team-activity'];

/** The HR area is one row; its screens are tabs (lib/hr/tabs.ts). */
const HR_ROW = ['/hr'];

/** Every HR tab, as an owner or admin sees the bar. */
const HR_ALL = HR_TABS.map((tab) => tab.href);

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

const ALL_ITEMS = [
  ...NAV_GROUPS.flatMap((g) => g.items),
  ...Object.values(TEAM_VIEW_ITEMS),
  ...BOTTOM_NAV_ITEMS,
];

describe('visibleNavGroups', () => {
  it.each([
    [null, VIEWER],
    ['viewer', VIEWER],
    ['agent', AGENT],
  ] as const)(
    'gives %s its groups, with no team-wide or admin views',
    (role, groups) => {
      expect(layout(visibleNavGroups(role))).toEqual(groups);
    }
  );

  it('adds the team views and Team activity for a team leader', () => {
    expect(layout(visibleNavGroups('team_leader'))).toEqual({
      ...LEADER,
      team: TEAM,
    });
  });

  it('keeps the unread-badge rows single: no Team inbox / Team contacts rows', () => {
    const hrefs = visibleNavGroups('owner').flatMap((g) =>
      g.items.map((i) => i.href)
    );
    expect(hrefs).not.toContain('/team-inbox');
    expect(hrefs).not.toContain('/team-contacts');
    expect(hrefs.filter((h) => h.startsWith('/hr'))).toEqual(['/hr']);
  });

  it.each([
    ['admin', ['/reports/funnel']],
    ['owner', ['/reports/funnel', '/reports/tags']],
  ] as const)('shows %s every group', (role, reports) => {
    expect(layout(visibleNavGroups(role))).toEqual({
      ...LEADER,
      // The chat tag report is the owner's, or a grant's (migration 255).
      reports,
      team: [...TEAM, ...HR_ROW],
      automation: ['/broadcasts', '/automations', '/flows'],
      integrations: ['/compass', '/opendesk'],
    });
  });

  it('shows the chat tag report to someone the owner granted it, and no one else', () => {
    const tags = (role: AccountRole, reportKeys: readonly 'chat_tags'[] = []) =>
      visibleNavGroups(role, { reportKeys })
        .flatMap((g) => g.items.map((i) => i.href))
        .includes('/reports/tags');
    expect(tags('agent', ['chat_tags'])).toBe(true);
    expect(tags('admin', ['chat_tags'])).toBe(true);
    expect(tags('agent')).toBe(false);
    expect(tags('admin')).toBe(false);
    expect(tags('owner')).toBe(true);
    expect(tags('bank_guest', ['chat_tags'])).toBe(false);
  });

  it("orders the groups by area, the higher roles' views last", () => {
    expect(visibleNavGroups('owner').map((g) => g.id)).toEqual([
      'main',
      'collaboration',
      'conversations',
      'customers',
      'submissions',
      'reports',
      'team',
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
      ).toEqual(['/inbox', '/calls', '/groups', '/group-wall']);
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
        '/desk',
        ...(role === 'agent' ? [] : ['/recycle']),
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

  describe('the HR area (200): one row, tabs inside', () => {
    const hrRow = (
      role: AccountRole | null,
      ctx: Parameters<typeof visibleNavGroups>[1]
    ) =>
      visibleNavGroups(role, ctx)
        .flatMap((g) => g.items)
        .filter((i) => i.href.startsWith('/hr'))
        .map((i) => i.href);
    const roles = (
      recruiter: 'lead' | 'member' | null,
      dept: 'lead' | 'member' | null
    ) => ({ admin: false, recruiter, dept });
    const adminRoles = { admin: true, recruiter: null, dept: null };
    const tabs = (r: Parameters<typeof visibleHrTabs>[0]) =>
      visibleHrTabs(r).map((t) => t.href);

    it('shows an admin the one HR row, roles known or not, and every tab', () => {
      expect(hrRow('admin', {})).toEqual(['/hr']);
      expect(hrRow('owner', { hrRoles: null })).toEqual(['/hr']);
      expect(tabs(adminRoles)).toEqual(HR_ALL);
    });

    it('shows a recruiter lead the recruitment tabs, not HR department', () => {
      expect(hrRow('agent', { hrRoles: roles('lead', null) })).toEqual(['/hr']);
      expect(tabs(roles('lead', null))).toEqual([
        '/hr/recruiter',
        '/hr/unsorted',
        '/hr/tasks',
        '/hr/rules',
        '/hr/hire-fast',
        '/hr/automated-messages',
      ]);
    });

    it('shows a recruiter member Hire fast but not Automated messages', () => {
      expect(tabs(roles('member', null))).toEqual([
        '/hr/recruiter',
        '/hr/unsorted',
        '/hr/tasks',
        '/hr/rules',
        '/hr/hire-fast',
      ]);
    });

    it('shows a dept member no Recruiter HR and no Hire fast', () => {
      expect(tabs(roles(null, 'member'))).toEqual([
        '/hr/department',
        '/hr/unsorted',
        '/hr/tasks',
        '/hr/rules',
      ]);
      // A dept lead leads no recruitment: still no Automated messages.
      expect(tabs(roles(null, 'lead'))).not.toContain('/hr/automated-messages');
    });

    it('lands /hr on the first tab the person may open', () => {
      expect(hrLandingPath(adminRoles)).toBe('/hr/recruiter');
      expect(hrLandingPath(roles(null, 'member'))).toBe('/hr/department');
      expect(hrLandingPath(roles(null, null))).toBeNull();
      expect(hrLandingPath(null)).toBeNull();
    });

    it('keeps the HR row for a restricted department (HR people are one)', () => {
      expect(
        hrRow('agent', {
          hrRoles: roles(null, 'member'),
          salesRestricted: true,
        })
      ).toEqual(['/hr']);
    });

    it('hides the row from staff with no HR role, a guest and a loading role', () => {
      expect(hrRow('agent', {})).toEqual([]);
      expect(hrRow('team_leader', { hrRoles: roles(null, null) })).toEqual([]);
      for (const role of [null, 'bank_guest'] as const)
        expect(
          hrRow(role, { hrRoles: roles('lead', 'lead') }),
          String(role)
        ).toEqual([]);
    });

    it('opens nothing else for an HR-only agent', () => {
      const all = visibleNavGroups('agent', { hrRoles: roles('lead', 'lead') });
      expect(layout(all)).toEqual({ ...AGENT, team: HR_ROW });
    });
  });

  describe('the Mine / Team switch', () => {
    it('is offered to exactly those who had the Team rows', () => {
      for (const screen of ['inbox', 'contacts'] as const) {
        for (const role of [null, 'viewer', 'agent', 'bank_guest'] as const)
          expect(canUseTeamView(screen, role), `${screen} ${role}`).toBe(false);
        for (const role of ['team_leader', 'admin', 'owner'] as const)
          expect(canUseTeamView(screen, role), `${screen} ${role}`).toBe(true);
      }
    });

    it('hides Team contacts, not Team inbox, from a restricted department', () => {
      expect(
        canUseTeamView('contacts', 'team_leader', { salesRestricted: true })
      ).toBe(false);
      expect(
        canUseTeamView('inbox', 'team_leader', { salesRestricted: true })
      ).toBe(true);
    });

    it('keeps the team routes as links and lights the parent row on them', () => {
      expect(TEAM_VIEW_ITEMS.inbox.href).toBe('/team-inbox');
      expect(TEAM_VIEW_ITEMS.contacts.href).toBe('/team-contacts');
      const inbox = NAV_GROUPS.flatMap((g) => g.items).find(
        (i) => i.href === '/inbox'
      )!;
      expect(isNavRowActive(inbox, '/inbox')).toBe(true);
      expect(isNavRowActive(inbox, '/team-inbox')).toBe(true);
      expect(isNavRowActive(inbox, '/contacts')).toBe(false);
    });
  });

  describe('the Reports slot', () => {
    const slot = NAV_GROUPS.find((g) => g.id === 'reports');

    it('exists, is headed, and renders nothing for a role that may open none of it', () => {
      expect(slot).toBeDefined();
      expect(slot!.labelKey).toBe('groups.reports');
      expect(slot!.items.map((i) => i.href)).toEqual([
        '/reports/funnel',
        '/reports/tags',
      ]);
      for (const role of [
        null,
        'bank_guest',
        'viewer',
        'agent',
        'team_leader',
      ] as const)
        expect(
          visibleNavGroups(role).map((g) => g.id),
          String(role)
        ).not.toContain('reports');
    });

    it('shows up, between submissions and team, once a track registers an item', () => {
      const withItem = NAV_GROUPS.map((g) =>
        g.id === 'reports'
          ? {
              ...g,
              items: [
                {
                  href: '/reports/x',
                  labelKey: 'dashboard',
                  icon: ALL_ITEMS[0].icon,
                  minRole: 'team_leader' as const,
                },
              ],
            }
          : g
      );
      const ids = (role: AccountRole | null) =>
        visibleNavGroups(role, {}, withItem).map((g) => g.id);
      expect(ids('owner')).toContain('reports');
      expect(ids('owner').indexOf('reports')).toBe(
        ids('owner').indexOf('team') - 1
      );
      // Role guards still apply to a registered item.
      expect(ids('agent')).not.toContain('reports');
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

  // A row marked guarded with no guard (or a guard the row does not know
  // about) says the wrong thing about who may open the route.
  it("marks a row guarded exactly when its route's layout guards it", () => {
    const appDir = join(process.cwd(), 'src', 'app', '(dashboard)');
    for (const item of ALL_ITEMS) {
      const source = routeLayout(appDir, item.href);
      const guarded =
        /\b(Admin|TeamLeader|Agent|Staff)OnlyLayout\b/.test(source) ||
        /\b(CallReviewer|HrAccess|ReportAccess)Layout\b/.test(source);
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

describe('NAV_PREFETCH', () => {
  // Next's `auto` prefetches a dynamic route only down to the dashboard's
  // loading boundary, so each click would wait out a round trip. Screens
  // stay dynamic while the language is read from a cookie on every
  // request; if that ever stops, this comment and NAV_PREFETCH go too.
  it('fully prefetches, because reading the language makes every screen dynamic', () => {
    expect(NAV_PREFETCH).toBe(true);
    const request = readFileSync(
      join(process.cwd(), 'src', 'i18n', 'request.ts'),
      'utf8'
    );
    expect(request).toMatch(/await cookies\(\)/);
  });

  it.each([
    ['components/layout/sidebar.tsx', 1],
    ['components/layout/mobile-tab-bar.tsx', 1],
    ['components/layout/team-view-switch.tsx', 2],
    ['components/hr/hr-tabs.tsx', 1],
  ])('is on every navigation row of %s', (file, count) => {
    const source = readFileSync(join(process.cwd(), 'src', file), 'utf8');
    expect(source.match(/prefetch=\{NAV_PREFETCH\}/g) ?? []).toHaveLength(
      count
    );
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
    expect(hrefs(true)).toContain('/inbox');
    // The team views are the Mine / Team switch now; a restricted (HR)
    // team leader still gets the inbox one, never the contacts one.
    expect(
      canUseTeamView('inbox', 'team_leader', { salesRestricted: true })
    ).toBe(true);
    expect(
      canUseTeamView('contacts', 'team_leader', { salesRestricted: true })
    ).toBe(false);
  });
});
