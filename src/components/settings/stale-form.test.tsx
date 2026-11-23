import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// A settings screen left open must not write its old values back over
// what another admin saved meanwhile: a save sends what was changed.
vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => {
  const t = Object.assign((k: string) => k, { rich: (k: string) => k });
  return { useTranslations: () => t };
});
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'acc-1' }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { Button } from '@/components/ui/button';
import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';
import { AssignmentPeoplePicker } from '@/components/assignment/people-picker';
import { ChatAssignmentPanel } from './chat-assignment-panel';
import { ResponseTimesPanel } from './response-times-panel';

const HOURS = { mon: [['09:00', '18:00']] };

const find = (Panel: () => ReactNode, prop: string, value: string) =>
  findElements(render(Panel), (el) => el.props[prop] === value)[0];
const saveButton = (Panel: () => ReactNode) =>
  findElements(render(Panel), (el) => el.type === Button).at(-1)!;

async function open(Panel: () => ReactNode, settings: object, extra = {}) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ settings, available: true, ...extra }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  render(Panel);
  await settle();
  return async () => {
    (saveButton(Panel).props.onClick as () => void)();
    await settle();
    const call = fetchMock.mock.calls.at(-1) as unknown as [
      string,
      RequestInit,
    ];
    return call[1].method === 'PUT'
      ? JSON.parse(String(call[1].body))
      : undefined;
  };
}

beforeEach(() => {
  resetHooks();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ResponseTimesPanel', () => {
  const stored = {
    enabled: false,
    timezone: 'Asia/Dubai',
    hours: HOURS,
    targetMinutes: 42,
  };

  it('sends only the field that was changed', async () => {
    const save = await open(ResponseTimesPanel, stored);
    const target = find(ResponseTimesPanel, 'id', 'rt-target');
    (target.props.onChange as (e: object) => void)({ target: { value: '10' } });
    expect(await save()).toEqual({ targetMinutes: 10 });
  });

  it('has nothing to save when a change was undone', async () => {
    const save = await open(ResponseTimesPanel, stored);
    const toggle = (on: boolean) =>
      (
        find(ResponseTimesPanel, 'aria-labelledby', 'rt-enabled').props
          .onCheckedChange as (on: boolean) => void
      )(on);
    toggle(true);
    expect(saveButton(ResponseTimesPanel).props.disabled).toBe(false);
    toggle(false);
    expect(saveButton(ResponseTimesPanel).props.disabled).toBe(true);
    expect(await save()).toBeUndefined();
  });
});

describe('ChatAssignmentPanel', () => {
  const stored = {
    broadcastRotationEnabled: false,
    broadcastPool: ['u1'],
    compassAssignEnabled: true,
    limitsEnabled: false,
    defaultChatLimit: 42,
  };
  const member = (userId: string) => ({
    userId,
    name: userId,
    role: 'agent',
    deactivated: false,
    openCount: 0,
    limit: null,
  });
  const openPanel = () =>
    open(ChatAssignmentPanel, stored, {
      members: [member('u1'), member('u2')],
    });

  it('sends only the switch that was changed', async () => {
    const save = await openPanel();
    (
      find(ChatAssignmentPanel, 'aria-labelledby', 'ca-limits').props
        .onCheckedChange as (on: boolean) => void
    )(true);
    expect(await save()).toEqual({ limitsEnabled: true });
  });

  it('sends who joined the rotation, not the whole list', async () => {
    const save = await openPanel();
    const [picker] = findElements(
      render(ChatAssignmentPanel),
      (el) => el.type === AssignmentPeoplePicker
    );
    (picker.props.onChange as (next: string[]) => void)(['u1', 'u2']);
    expect(await save()).toEqual({
      broadcastPoolChange: { add: ['u2'], remove: [], fromEveryone: false },
    });
  });

  it('says so when the open chats could not be read, not 0', async () => {
    const lines = async (openCount: number | null) => {
      resetHooks();
      await open(ChatAssignmentPanel, stored, {
        members: [{ ...member('u1'), limit: 5, openCount }],
      });
      return findElements(render(ChatAssignmentPanel), (el) =>
        /^limits\.open(Now|Unknown)$/.test(String(el.props.children))
      ).map((el) => el.props.children);
    };
    expect(await lines(null)).toEqual(['limits.openUnknown']);
    expect(await lines(0)).toEqual(['limits.openNow']);
  });

  it('a changed default limit goes alone; the same text is nothing to save', async () => {
    const save = await openPanel();
    const type = (value: string) =>
      (
        find(ChatAssignmentPanel, 'id', 'ca-default-limit').props.onChange as (
          e: object
        ) => void
      )({ target: { value } });
    type('42');
    expect(saveButton(ChatAssignmentPanel).props.disabled).toBe(true);
    type('7');
    expect(await save()).toEqual({ defaultChatLimit: 7 });
  });
});
