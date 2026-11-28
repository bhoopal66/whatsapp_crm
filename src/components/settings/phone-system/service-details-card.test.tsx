import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The card is owners' and admins' only, whoever mounts it: the route and
// 336's RPCs refuse everyone else, so no one else may even see it.
const auth = vi.hoisted(() => ({ role: 'admin' as string | null }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountRole: auth.role }),
}));
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ServiceDetailsCard } from './service-details-card';

describe('ServiceDetailsCard', () => {
  for (const role of ['owner', 'admin']) {
    it(`shows the card to an ${role}`, () => {
      auth.role = role;
      expect(renderToStaticMarkup(<ServiceDetailsCard />)).toContain('title');
    });
  }
  for (const role of ['team_leader', 'agent', 'viewer', null]) {
    it(`renders nothing for ${role ?? 'no role yet'}`, () => {
      auth.role = role;
      expect(renderToStaticMarkup(<ServiceDetailsCard />)).toBe('');
    });
  }
});
