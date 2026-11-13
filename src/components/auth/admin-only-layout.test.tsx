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
vi.mock('@/lib/auth/account', () => ({ getCurrentAccount: mocks.getCurrentAccount }));

import {
  AdminOnlyLayout,
  CallReviewerLayout,
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
      renderSales({ role: 'agent', department: 'sales', salesRestricted: false })
    ).resolves.toBeDefined();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('sends a restricted department to their own inbox', async () => {
    await expect(
      renderSales({ role: 'team_leader', department: 'hr', salesRestricted: true })
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
    mocks.getCurrentAccount.mockResolvedValue({ role, accountId: 'a1', userId: 'u1' });
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
    await expect(AdminOnlyLayout({ children: 'PAGE' })).rejects.toThrow(/REDIRECT/);
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
