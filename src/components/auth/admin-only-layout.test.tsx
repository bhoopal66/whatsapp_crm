import { beforeEach, describe, expect, it, vi } from 'vitest';

// The sidebar hides the workspace-configuration screens from agents
// and viewers, but hiding a link is presentation. THIS is the boundary:
// a typed URL, a bookmark, or a stale history entry all land here.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  redirect: vi.fn((path: string) => {
    // Stand-in for Next's redirect(), which signals by throwing. The
    // throw is the point: the component must not go on to render its
    // children after calling it.
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
}));

import {
  AdminOnlyLayout,
  CallReviewerLayout,
  HrAccessLayout,
  ReportAccessLayout,
  ReportsLandingLayout,
  SalesOnlyLayout,
  StaffOnlyLayout,
} from './admin-only-layout';

describe('SalesOnlyLayout', () => {
  beforeEach(() => vi.clearAllMocks());

  const renderSales = async (ctx: object | null) => {
    if (ctx === null)
      mocks.getCurrentAccount.mockRejectedValue(new Error('Unauthorized'));
    else mocks.getCurrentAccount.mockResolvedValue(ctx);
    return SalesOnlyLayout({ children: 'PAGE' });
  };

  it('renders the page for someone whose department is not restricted', async () => {
    await expect(
      renderSales({
        role: 'agent',
        department: 'sales',
        salesRestricted: false,
      })
    ).resolves.toBeDefined();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('sends a restricted department to their own inbox', async () => {
    await expect(
      renderSales({
        role: 'team_leader',
        department: 'hr',
        salesRestricted: true,
      })
    ).rejects.toThrow('REDIRECT:/inbox');
  });

  it('sends a signed-out caller to login', async () => {
    await expect(renderSales(null)).rejects.toThrow('REDIRECT:/login');
  });
});

async function render(role: string | null) {
  if (role === null) {
    mocks.getCurrentAccount.mockRejectedValue(new Error('Unauthorized'));
  } else {
    mocks.getCurrentAccount.mockResolvedValue({
      role,
      accountId: 'a1',
      userId: 'u1',
    });
  }
  return AdminOnlyLayout({ children: 'PAGE' });
}

describe('AdminOnlyLayout', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the page for an owner', async () => {
    await expect(render('owner')).resolves.toBeDefined();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('renders the page for an admin', async () => {
    await expect(render('admin')).resolves.toBeDefined();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('redirects an agent to the dashboard', async () => {
    await expect(render('agent')).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('redirects a viewer to the dashboard', async () => {
    await expect(render('viewer')).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('sends a signed-out caller to login, not the dashboard', async () => {
    await expect(render(null)).rejects.toThrow('REDIRECT:/login');
  });

  it('does not let the redirect be swallowed by its own error handling', async () => {
    // Regression guard: redirect() throws, so calling it inside the
    // try/catch that wraps getCurrentAccount would catch the redirect
    // and fall through to rendering the page for an agent.
    mocks.getCurrentAccount.mockResolvedValue({ role: 'agent' });
    await expect(AdminOnlyLayout({ children: 'PAGE' })).rejects.toThrow(
      /REDIRECT/
    );
  });
});

describe('StaffOnlyLayout', () => {
  beforeEach(() => vi.clearAllMocks());

  const renderStaff = async (role: string | null) => {
    if (role === null)
      mocks.getCurrentAccount.mockRejectedValue(new Error('Unauthorized'));
    else
      mocks.getCurrentAccount.mockResolvedValue({
        role,
        accountId: 'a1',
        userId: 'u1',
      });
    return StaffOnlyLayout({ children: 'PAGE' });
  };

  it.each(['viewer', 'agent', 'team_leader', 'admin', 'owner'])(
    'renders the page for a %s',
    async (role) => {
      await expect(renderStaff(role)).resolves.toBeDefined();
      expect(mocks.redirect).not.toHaveBeenCalled();
    }
  );

  it('sends a bank guest to team chat, their one screen', async () => {
    await expect(renderStaff('bank_guest')).rejects.toThrow('REDIRECT:/chat');
  });

  it('sends a signed-out caller to login', async () => {
    await expect(renderStaff(null)).rejects.toThrow('REDIRECT:/login');
  });
});

describe('CallReviewerLayout', () => {
  beforeEach(() => vi.clearAllMocks());

  // `rpc` answers pbx_sees_all_calls() (migration 198) as the caller.
  const renderReviewer = async (
    role: string | null,
    rpc: () => Promise<{ data: unknown; error: unknown }> = async () => ({
      data: false,
      error: null,
    })
  ) => {
    const rpcMock = vi.fn(rpc);
    if (role === null)
      mocks.getCurrentAccount.mockRejectedValue(new Error('Unauthorized'));
    else
      mocks.getCurrentAccount.mockResolvedValue({
        role,
        accountId: 'a1',
        userId: 'u1',
        supabase: { rpc: rpcMock },
      });
    return { page: CallReviewerLayout({ children: 'PAGE' }), rpcMock };
  };

  it.each(['team_leader', 'admin', 'owner'])(
    'renders the page for a %s without asking',
    async (role) => {
      const { page, rpcMock } = await renderReviewer(role);
      await expect(page).resolves.toBeDefined();
      expect(rpcMock).not.toHaveBeenCalled();
      expect(mocks.redirect).not.toHaveBeenCalled();
    }
  );

  it.each(['agent', 'viewer'])(
    'renders the page for a %s allowed to review every call',
    async (role) => {
      const { page, rpcMock } = await renderReviewer(role, async () => ({
        data: true,
        error: null,
      }));
      await expect(page).resolves.toBeDefined();
      expect(rpcMock).toHaveBeenCalledWith('pbx_sees_all_calls');
    }
  );

  it('redirects an agent who is not a reviewer to the dashboard', async () => {
    const { page } = await renderReviewer('agent');
    await expect(page).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('falls back to the role rule when the function is missing (pre-198)', async () => {
    const { page } = await renderReviewer('agent', async () => ({
      data: null,
      error: { code: 'PGRST202', message: 'not found' },
    }));
    await expect(page).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('treats a check that throws as a refusal, not a sign-out', async () => {
    const { page } = await renderReviewer('agent', async () => {
      throw new Error('network');
    });
    await expect(page).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('never asks for a bank guest', async () => {
    const { page, rpcMock } = await renderReviewer('bank_guest', async () => ({
      data: true,
      error: null,
    }));
    await expect(page).rejects.toThrow('REDIRECT:/dashboard');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('sends a signed-out caller to login', async () => {
    const { page } = await renderReviewer(null);
    await expect(page).rejects.toThrow('REDIRECT:/login');
  });
});

describe('HrAccessLayout', () => {
  beforeEach(() => vi.clearAllMocks());

  // `rpc` answers hr_my_roles() (migration 200) as the caller.
  const renderHr = async (
    role: string | null,
    rpc: () => Promise<{ data: unknown; error: unknown }> = async () => ({
      data: { admin: false, recruiter: null, dept: null },
      error: null,
    })
  ) => {
    const rpcMock = vi.fn(rpc);
    if (role === null)
      mocks.getCurrentAccount.mockRejectedValue(new Error('Unauthorized'));
    else
      mocks.getCurrentAccount.mockResolvedValue({
        role,
        accountId: 'a1',
        userId: 'u1',
        supabase: { rpc: rpcMock },
      });
    return { page: HrAccessLayout({ children: 'PAGE' }), rpcMock };
  };

  it.each(['admin', 'owner'])(
    'renders the page for an %s without asking',
    async (role) => {
      const { page, rpcMock } = await renderHr(role);
      await expect(page).resolves.toBeDefined();
      expect(rpcMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    { recruiter: 'member', dept: null },
    { recruiter: null, dept: 'lead' },
  ])('renders the page for an HR team member (%o)', async (team) => {
    const { page, rpcMock } = await renderHr('agent', async () => ({
      data: { admin: false, ...team },
      error: null,
    }));
    await expect(page).resolves.toBeDefined();
    expect(rpcMock).toHaveBeenCalledWith('hr_my_roles');
  });

  it('redirects an agent on no HR team to the dashboard', async () => {
    const { page } = await renderHr('agent');
    await expect(page).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('fails closed when the check errors (e.g. 200 not applied)', async () => {
    const { page } = await renderHr('team_leader', async () => ({
      data: null,
      error: { code: 'PGRST202', message: 'not found' },
    }));
    await expect(page).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('treats a check that throws as a refusal, not a sign-out', async () => {
    const { page } = await renderHr('agent', async () => {
      throw new Error('network');
    });
    await expect(page).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('sends a signed-out caller to login', async () => {
    const { page } = await renderHr(null);
    await expect(page).rejects.toThrow('REDIRECT:/login');
  });
});

// `rpc` answers report_my_access() (migration 255) as the caller.
async function renderReport(
  which: 'report' | 'landing',
  role: string | null,
  rpc: () => Promise<{ data: unknown; error: unknown }> = async () => ({
    data: [],
    error: null,
  })
) {
  const rpcMock = vi.fn(rpc);
  if (role === null)
    mocks.getCurrentAccount.mockRejectedValue(new Error('Unauthorized'));
  else
    mocks.getCurrentAccount.mockResolvedValue({
      role,
      accountId: 'a1',
      userId: 'u1',
      supabase: { rpc: rpcMock },
    });
  const page =
    which === 'report'
      ? ReportAccessLayout({ report: 'chat_tags', children: 'PAGE' })
      : ReportsLandingLayout({ children: 'PAGE' });
  return { page, rpcMock };
}

const granted = async () => ({ data: ['chat_tags'], error: null });

describe('ReportAccessLayout', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the page for the owner without asking', async () => {
    const { page, rpcMock } = await renderReport('report', 'owner');
    await expect(page).resolves.toBeDefined();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it.each(['admin', 'team_leader', 'agent', 'viewer'])(
    'renders the page for a granted %s',
    async (role) => {
      const { page, rpcMock } = await renderReport('report', role, granted);
      await expect(page).resolves.toBeDefined();
      expect(rpcMock).toHaveBeenCalledWith('report_my_access');
    }
  );

  it('redirects an admin with no grant: the report is per person', async () => {
    const { page } = await renderReport('report', 'admin');
    await expect(page).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('fails closed when the check errors (e.g. 255 not applied)', async () => {
    const { page } = await renderReport('report', 'agent', async () => ({
      data: null,
      error: { code: 'PGRST202', message: 'not found' },
    }));
    await expect(page).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('treats a check that throws as a refusal, not a sign-out', async () => {
    const { page } = await renderReport('report', 'agent', async () => {
      throw new Error('network');
    });
    await expect(page).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('never asks for a bank guest', async () => {
    const { page, rpcMock } = await renderReport(
      'report',
      'bank_guest',
      granted
    );
    await expect(page).rejects.toThrow('REDIRECT:/dashboard');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('sends a signed-out caller to login', async () => {
    const { page } = await renderReport('report', null);
    await expect(page).rejects.toThrow('REDIRECT:/login');
  });
});

describe('ReportsLandingLayout', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['owner', 'admin'])(
    'renders the landing for an %s without asking',
    async (role) => {
      const { page, rpcMock } = await renderReport('landing', role);
      await expect(page).resolves.toBeDefined();
      expect(rpcMock).not.toHaveBeenCalled();
    }
  );

  it('renders the landing for anyone holding a report key', async () => {
    const { page } = await renderReport('landing', 'agent', granted);
    await expect(page).resolves.toBeDefined();
  });

  it('redirects staff with no key', async () => {
    const { page } = await renderReport('landing', 'team_leader');
    await expect(page).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('ignores keys it does not know', async () => {
    const { page } = await renderReport('landing', 'agent', async () => ({
      data: ['something_else'],
      error: null,
    }));
    await expect(page).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('fails closed when the check errors', async () => {
    const { page } = await renderReport('landing', 'viewer', async () => ({
      data: null,
      error: { code: '42883', message: 'missing' },
    }));
    await expect(page).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('never asks for a bank guest', async () => {
    const { page, rpcMock } = await renderReport(
      'landing',
      'bank_guest',
      granted
    );
    await expect(page).rejects.toThrow('REDIRECT:/dashboard');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('sends a signed-out caller to login', async () => {
    const { page } = await renderReport('landing', null);
    await expect(page).rejects.toThrow('REDIRECT:/login');
  });
});

describe('an auth outage', () => {
  it('reaches the error boundary instead of /login', async () => {
    const { AuthUnavailableError } = await import('@/lib/auth/auth-unavailable');
    const outage = new AuthUnavailableError();
    mocks.redirect.mockClear();
    mocks.getCurrentAccount.mockRejectedValue(outage);
    for (const Layout of [
      AdminOnlyLayout,
      CallReviewerLayout,
      HrAccessLayout,
      ReportsLandingLayout,
      SalesOnlyLayout,
      StaffOnlyLayout,
    ]) {
      await expect(Layout({ children: null })).rejects.toBe(outage);
    }
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
