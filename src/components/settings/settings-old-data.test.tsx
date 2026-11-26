import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// A person's details are saved as what was changed, never as what an old
// screen still holds; a list that could not be read is not an empty one.
vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => {
  const t = Object.assign((k: string) => k, { rich: (k: string) => k });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
const m = vi.hoisted(() => ({
  update: vi.fn(),
  user: { id: 'u1' },
  profile: { full_name: 'Old Name', avatar_url: 'a.png', email: 'a@b.co' },
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    user: m.user,
    profile: m.profile,
    accountRole: 'owner',
    refreshProfile: vi.fn(),
  }),
}));
vi.mock('@/hooks/use-presence', () => ({
  usePresence: () => ({
    getPresence: () => 'offline',
    getRow: () => null,
    now: 0,
  }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      update: (values: unknown) => {
        m.update(values);
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ErrorState } from '@/components/dashboard/error-state';
import { Card } from '@/components/ui/card';
import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';
import { MemberDetailsDialog } from './member-details-dialog';
import { RevokableKey } from './member-handover-dialog';
import { MembersTab } from './members-tab';
import { MetaChannelConfig } from './meta-channel-config';
import { MyWhatsAppCard } from './my-whatsapp-card';
import { ProfileForm } from './profile-form';

const errors = (tree: ReactNode) =>
  findElements(tree, (el) => el.type === ErrorState);
const byId = (tree: ReactNode, id: string) =>
  findElements(tree, (el) => el.props.id === id)[0];
const call = (fn: unknown, arg?: unknown) => (fn as (a?: unknown) => void)(arg);
const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  clone: () => ok(body),
  json: async () => body,
});
const bad = (status = 500) => ({ ok: false, status, json: async () => ({}) });

beforeEach(() => {
  resetHooks();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('MemberDetailsDialog', () => {
  const onRefused = vi.fn();
  const Dialog = () =>
    MemberDetailsDialog({
      member: { user_id: 'u2', full_name: 'Sara Ali', email: 'sara@old.co' },
      onClose: vi.fn(),
      onSaved: vi.fn(),
      onRefused,
    });
  const save = async (id: string, value: string, answer: unknown) => {
    const fetchMock = vi.fn(async () => answer);
    vi.stubGlobal('fetch', fetchMock);
    call(byId(render(Dialog), id).props.onChange, { target: { value } });
    const [form] = findElements(render(Dialog), (el) => el.type === 'form');
    call(form.props.onSubmit, { preventDefault() {} });
    await settle();
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    return JSON.parse(String(init.body));
  };

  it('sends only the edited field, with what it showed', async () => {
    expect(await save('member-details-name', 'Sara Khan', ok({}))).toEqual({
      full_name: 'Sara Khan',
      expected_full_name: 'Sara Ali',
    });
    resetHooks();
    expect(await save('member-details-email', 'new@x.co', ok({}))).toEqual({
      email: 'new@x.co',
      expected_email: 'sara@old.co',
    });
    expect(onRefused).not.toHaveBeenCalled();
  });

  it('has the roster read again when it is refused as old', async () => {
    await save('member-details-name', 'Sara Khan', bad(409));
    expect(onRefused).toHaveBeenCalledOnce();
  });
});

describe('ProfileForm', () => {
  const submit = async () => {
    const [form] = findElements(render(ProfileForm), (e) => e.type === 'form');
    call(form.props.onSubmit, { preventDefault() {} });
    await settle();
  };

  it('a photo alone leaves the name alone', async () => {
    render(ProfileForm);
    const [remove] = findElements(
      render(ProfileForm),
      (el) =>
        Array.isArray(el.props.children) && el.props.children[1] === 'remove'
    );
    call(remove.props.onClick);
    await submit();
    expect(m.update).toHaveBeenCalledExactlyOnceWith({ avatar_url: null });
  });

  it('a name alone leaves the photo alone, and nothing saves nothing', async () => {
    render(ProfileForm);
    await submit();
    expect(m.update).not.toHaveBeenCalled();
    call(byId(render(ProfileForm), 'profile-full-name').props.onChange, {
      target: { value: 'New Name ' },
    });
    await submit();
    expect(m.update).toHaveBeenCalledExactlyOnceWith({ full_name: 'New Name' });
  });
});

describe('MembersTab', () => {
  const answers: Record<string, () => unknown> = {};
  beforeEach(() => {
    Object.assign(answers, {
      '/api/account/members': () => ok({ members: [] }),
      '/api/account/invitations': () => ok({ invitations: [] }),
      '/api/coordinators': () => ok({ coordinators: [] }),
      '/api/account/members/left-work': () =>
        ok({
          people: [],
          keys: [
            { id: 'k1', name: 'K', prefix: 'p', createdBy: 'u9', scopes: [] },
          ],
        }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => answers[url]())
    );
  });
  const open = async () => {
    render(MembersTab);
    await settle();
    return render(MembersTab);
  };
  const strays = (tree: ReactNode) =>
    findElements(tree, (el) => el.type === RevokableKey).length;

  it('a failed roster: an error with Retry, and nobody’s keys', async () => {
    answers['/api/account/members'] = () => bad();
    const tree = await open();
    expect(errors(tree).map((e) => e.props.message)).toEqual(['loadFailed']);
    expect(strays(tree)).toBe(0);
    answers['/api/account/members'] = () => ok({ members: [] });
    call(errors(tree)[0].props.onRetry);
    await settle();
    const again = render(MembersTab);
    expect(errors(again)).toHaveLength(0);
    expect(strays(again)).toBe(1);
  });

  it('failed invitations: an error with Retry, not "none"', async () => {
    answers['/api/account/invitations'] = () => bad();
    const tree = await open();
    expect(errors(tree).map((e) => e.props.message)).toEqual([
      'invitationsLoadFailed',
    ]);
    answers['/api/account/invitations'] = () => ok({ invitations: [] });
    call(errors(tree)[0].props.onRetry);
    await settle();
    expect(errors(render(MembersTab))).toHaveLength(0);
  });
});

describe('MetaChannelConfig', () => {
  it('a failed read: an error with Retry, no blank form', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(bad())
      .mockResolvedValue(ok({ connected: false, subscribed: false }));
    vi.stubGlobal('fetch', fetchMock);
    render(MetaChannelConfig);
    await settle();
    const tree = render(MetaChannelConfig);
    expect(errors(tree)).toHaveLength(1);
    expect(findElements(tree, (e) => 'value' in e.props)).toHaveLength(0);
    call(errors(tree)[0].props.onRetry);
    await settle();
    const again = render(MetaChannelConfig);
    expect(errors(again)).toHaveLength(0);
    expect(
      findElements(again, (e) => 'value' in e.props).length
    ).toBeGreaterThan(0);
  });
});

describe('MyWhatsAppCard', () => {
  const INFO = {
    allowed: true,
    configured: true,
    number: { id: 'n1', label: 'Mine', status: 'connected', phone: '97150' },
    import: { status: 'running', chats_done: 1, chats_total: 5 },
  };
  const cards = () =>
    findElements(render(MyWhatsAppCard), (e) => e.type === Card);

  it('a failed first read: an error with Retry; a guest’s 403 stays hidden', async () => {
    let answer: unknown = bad();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer)
    );
    render(MyWhatsAppCard);
    await settle();
    const [error] = errors(render(MyWhatsAppCard));
    expect(error.props.message).toBe('loadFailed');
    answer = bad(403);
    call(error.props.onRetry);
    await settle();
    expect(render(MyWhatsAppCard)).toBeNull();
  });

  it('a failed poll keeps the card and the polling', async () => {
    vi.useFakeTimers();
    let down = false;
    const fetchMock = vi.fn(async (url: string) =>
      down ? bad() : ok(url.endsWith('/status') ? { status: 'ready' } : INFO)
    );
    vi.stubGlobal('fetch', fetchMock);
    render(MyWhatsAppCard);
    await vi.advanceTimersByTimeAsync(0);
    expect(cards()).toHaveLength(1);
    down = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cards()).toHaveLength(1);
    expect(errors(render(MyWhatsAppCard))).toHaveLength(0);
    const before = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });
});
