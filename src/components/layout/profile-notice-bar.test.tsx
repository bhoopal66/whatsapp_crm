import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const auth = vi.hoisted(() => ({
  profileNotice: null as unknown,
  followProfileNotice: () => {},
  dismissProfileNotice: () => {},
}));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => auth }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/components/ui/button', () => ({
  Button: ({ children }: { children: ReactNode }) => (
    <button>{children}</button>
  ),
}));

import { ProfileNoticeBar } from './profile-notice-bar';

const html = () => renderToStaticMarkup(<ProfileNoticeBar />);

/** The bar's button labelled `key`, as an element (nothing mounts here). */
function button(key: string) {
  type El = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  const find = (node: ReactNode): El | null => {
    if (Array.isArray(node)) {
      return node.reduce<El | null>((hit, n) => hit ?? find(n), null);
    }
    if (!node || typeof node !== 'object') return null;
    const el = node as El;
    if (el.props.onClick && el.props.children === key) return el;
    return find(el.props.children);
  };
  return find(ProfileNoticeBar())!;
}

describe('ProfileNoticeBar', () => {
  beforeEach(() => {
    auth.profileNotice = null;
  });

  it('is nothing without a notice', () => {
    expect(html()).toBe('');
  });

  it('says which of the two happened', () => {
    auth.profileNotice = { kind: 'switched', role: 'agent' };
    expect(html()).toContain('switchedElsewhere');
    auth.profileNotice = { kind: 'deactivated' };
    expect(html()).toContain('workspaceDeactivated');
    expect(html()).not.toContain('switchedElsewhere');
  });

  it('reloads, or hides, when asked to', () => {
    auth.profileNotice = { kind: 'deactivated' };
    expect(button('reload').props.onClick).toBe(auth.followProfileNotice);
    expect(button('dismiss').props.onClick).toBe(auth.dismissProfileNotice);
  });
});
