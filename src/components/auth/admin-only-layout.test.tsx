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

import { AdminOnlyLayout, StaffOnlyLayout } from './admin-only-layout';

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
