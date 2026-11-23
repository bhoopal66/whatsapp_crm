import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';

import en from '../../../../../messages/en.json';
import type { AccountRole } from '@/lib/auth/roles';

// The list with one contact on it, rendered for each role: who is
// offered Delete in the row's "…" menu and on right-click.
const mocks = vi.hoisted(() => ({
  role: null as string | null,
  menus: [] as (() => { id?: string }[])[],
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => '/contacts',
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    user: { id: 'u1' },
    accountId: 'a1',
    accountRole: mocks.role,
    profileLoading: false,
  }),
}));
vi.mock('@/hooks/use-session-query', () => ({
  useSessionQuery: () => ({
    data: {
      total: 1,
      rows: [
        {
          id: 'c1',
          name: 'Sara',
          phone: '971500000001',
          email: null,
          company: null,
          created_at: '2026-11-01T00:00:00Z',
        },
      ],
    },
    loading: false,
    refreshing: false,
    error: null,
    refresh: async () => {},
  }),
}));
vi.mock('@/hooks/use-chat-tags', () => ({
  useChatTags: () => ({
    tags: [],
    tree: { mains: [], byId: new Map() },
  }),
}));
vi.mock('@/components/meetings/use-workspace-members', () => ({
  useWorkspaceMembers: () => ({ nameOf: () => null }),
}));
vi.mock('@/components/layout/team-view-switch', () => ({
  TeamViewSwitch: () => null,
}));
vi.mock('@/components/saved-views/saved-views-menu', () => ({
  SavedViewsMenu: () => null,
}));
vi.mock('@/components/contacts/contact-form', () => ({
  ContactForm: () => null,
}));
vi.mock('@/components/contacts/import-modal', () => ({
  ImportModal: () => null,
}));
vi.mock('@/components/contacts/custom-fields-manager', () => ({
  CustomFieldsManager: () => null,
}));
vi.mock('@/components/contacts/phone-cell', () => ({ PhoneCell: () => null }));
vi.mock('@/components/context-menu/registry', () => ({
  useContextMenuItems: (_: unknown, build: () => { id?: string }[]) => {
    mocks.menus.push(build);
  },
}));
// Open, so the menu's items are in the markup.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: Pass,
    DropdownMenuCheckboxItem: Pass,
    DropdownMenuLabel: Pass,
    DropdownMenuGroup: Pass,
    DropdownMenuSeparator: () => null,
  };
});

import ContactsPage from './page';

function offered(role: AccountRole) {
  mocks.role = role;
  const html = renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      timeZone="Asia/Dubai"
      messages={en as unknown as AbstractIntlMessages}
    >
      <ContactsPage />
    </NextIntlClientProvider>
  );
  const ids = mocks.menus.flatMap((build) => build().map((e) => e.id));
  return {
    rowEdit: html.includes(en.Contacts.page.editAction),
    rowDelete: html.includes(en.Contacts.page.deleteAction),
    menuEdit: ids.includes('edit'),
    menuDelete: ids.includes('delete'),
  };
}

describe('contacts list: delete', () => {
  beforeEach(() => {
    mocks.menus.length = 0;
  });

  it.each(['agent', 'team_leader'] as const)('is hidden from %s', (role) => {
    expect(offered(role)).toEqual({
      rowEdit: true,
      rowDelete: false,
      menuEdit: true,
      menuDelete: false,
    });
  });

  it.each(['admin', 'owner'] as const)('is offered to %s', (role) => {
    expect(offered(role)).toEqual({
      rowEdit: true,
      rowDelete: true,
      menuEdit: true,
      menuDelete: true,
    });
  });

  // Nothing is ticked on a first render, so the bulk bar is not there.
  it('is passed to the bulk bar by the same rule', () => {
    const src = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
    expect(src).toContain(
      'const canDelete = customerAccess(accountRole).deleteContact;'
    );
    expect(src).toMatch(/<BulkBar[^>]*canDelete=\{canDelete\}/);
  });
});
