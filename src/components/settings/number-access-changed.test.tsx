import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// Who may use a number, and who is in a team, after 314: a save refused
// because another admin saved first keeps the admin's choice on screen.
vi.mock('react', async (importOriginal) => {
  const { mockReact } = await import('@/test/hook-renderer');
  return mockReact(await importOriginal<typeof import('react')>());
});
vi.mock('next-intl', () => ({
  useTranslations: () => (k: string, v?: Record<string, unknown>) =>
    v ? `${k}:${Object.values(v).join('|')}` : k,
  useLocale: () => 'en',
}));
vi.mock('@/hooks/use-whatsapp-numbers', () => ({
  useAccountNumbers: () => [],
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from 'sonner';

import { findElements, render, resetHooks, settle } from '@/test/hook-renderer';

import { ChangedNotice } from './changed-notice';
import { NumbersLeftToAdmins } from './numbers-left-to-admins';
import { TeamEditorSheet } from './teams/team-editor-sheet';
import { TeamsTab } from './teams-tab';
import { WhatsAppNumbers } from './whatsapp-numbers';

type El = ReactElement<Record<string, unknown>>;
type Reply = { status: number; body: unknown };

const person = (user_id: string, deactivated_at: string | null = null) => ({
  user_id,
  full_name: user_id.toUpperCase(),
  email: `${user_id}@x.test`,
  role: 'agent',
  deactivated_at,
});
const number = (over: object = {}) => ({
  id: 'n1',
  provider: 'whapi',
  label: 'Sales line',
  phone_number_id: 'p',
  waba_id: null,
  is_primary: true,
  status: 'connected',
  registered_at: 'x',
  member_ids: ['ana'],
  team_ids: [],
  team_member_ids: [],
  access_restricted: true,
  conversation_count: 0,
  ...over,
});
const team = (over: object = {}) => ({
  id: 't1',
  name: 'Sales',
  leader_user_id: null,
  created_at: 'x',
  member_ids: ['ana'],
  channel_ids: ['n1'],
  ...over,
});

let numbers: object[];
let teams: object[];
let failing: string[];
let patchReply: () => Reply | Promise<Reply>;
const sent: Record<string, unknown>[] = [];

beforeEach(() => {
  resetHooks();
  vi.clearAllMocks();
  sent.length = 0;
  failing = [];
  numbers = [number()];
  teams = [team()];
  patchReply = () => ({ status: 200, body: {} });
  vi.stubGlobal('window', { location: { search: '' } });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    let reply: Reply = { status: 200, body: {} };
    if (init?.method === 'PATCH') {
      sent.push(JSON.parse(String(init.body)));
      reply = await patchReply();
    } else if (failing.includes(url)) reply = { status: 500, body: {} };
    else if (url === '/api/whatsapp/channels')
      reply = { status: 200, body: { channels: numbers } };
    else if (url === '/api/account/teams')
      reply = { status: 200, body: { teams } };
    else if (url === '/api/account/members')
      reply = {
        status: 200,
        body: { members: [person('ana'), person('bo'), person('old', 'x')] },
      };
    const { status, body } = reply;
    const res = { ok: status < 300, status, json: async () => body };
    return { ...res, clone: () => res };
  });
});
afterEach(() => vi.unstubAllGlobals());

const textOf = (node: ReactNode): string =>
  Array.isArray(node)
    ? node.map(textOf).join('')
    : typeof node === 'object'
      ? ''
      : String(node ?? '');
const texts = (tree: ReactNode) =>
  findElements(tree, () => true)
    .map((el) => textOf(el.props.children as ReactNode))
    .join('\n');
const button = (tree: ReactNode, label: string) =>
  findElements(
    tree,
    (el) =>
      !!el.props.onClick &&
      textOf(el.props.children as ReactNode).endsWith(label)
  )[0];
const press = async (tree: ReactNode, label: string) => {
  (button(tree, label).props.onClick as () => void)();
  await settle();
};
const notice = (tree: ReactNode) =>
  findElements(tree, (el) => el.type === ChangedNotice)[0];
const reload = (tree: ReactNode) =>
  (notice(tree).props.onReload as () => Promise<void>)();

describe('the access dialog', () => {
  const view = () => render(() => WhatsAppNumbers());
  const rows = () =>
    findElements(
      view(),
      (el) => el.type === 'label' && !!findBox(el)
    ) as unknown as El[];
  const findBox = (el: El) =>
    findElements(
      el.props.children as ReactNode,
      (x) => !!x.props.onCheckedChange
    )[0];
  const box = (name: string) =>
    findBox(rows().find((r) => texts(r).includes(name))!);
  const tick = (name: string, on: boolean) =>
    (box(name).props.onCheckedChange as (v: boolean) => void)(on);
  async function open() {
    view();
    await settle();
    await press(view(), 'manageAccess');
  }
  const changedTo = (row: object) => () => {
    numbers = [row];
    return { status: 409, body: { code: 'access_changed' } };
  };

  it('keeps the draft after a 409, names what is stored, saves after Reload', async () => {
    await open();
    tick('OLD', true);
    patchReply = changedTo(number({ member_ids: ['bo'], team_ids: ['t1'] }));
    await press(view(), 'saveAccess');
    expect(box('OLD').props.checked).toBe(true);
    expect(box('ANA').props.checked).toBe(true);
    expect(notice(view()).props.text).toBe(
      'accessChangedStored:storedPeople:BO · storedTeams:Sales'
    );
    expect(button(view(), 'saveAccess').props.disabled).toBe(true);
    await reload(view());
    expect(notice(view())).toBeUndefined();
    expect(box('BO').props.checked).toBe(true);
    expect(box('OLD').props.checked).toBe(false);
    expect(button(view(), 'saveAccess').props.disabled).toBe(false);
    await press(view(), 'saveAccess');
    expect(sent[1].expected_member_ids).toEqual(['bo']);
  });

  it('says a failed read in the notice, with a Retry', async () => {
    await open();
    tick('BO', true);
    const stored = changedTo(number({ member_ids: [] }));
    patchReply = () => {
      failing = ['/api/whatsapp/channels'];
      return stored();
    };
    await press(view(), 'saveAccess');
    expect(notice(view()).props).toMatchObject({
      text: 'accessChangedUnread',
      label: 'retry',
    });
    expect(toast.error).not.toHaveBeenCalled();
    failing = [];
    await reload(view());
    expect(notice(view()).props.text).toBe(
      'accessChangedStored:adminsOnlyTitle'
    );
    expect(box('BO').props.checked).toBe(true);
  });

  it('a dialog closed while the save ran stays closed', async () => {
    await open();
    tick('BO', true);
    let answer = () => {};
    patchReply = () =>
      new Promise<Reply>((done) => {
        answer = () => done(changedTo(number({ member_ids: ['bo'] }))());
      });
    await press(view(), 'saveAccess');
    await press(view(), 'cancel');
    answer();
    await settle();
    await settle();
    expect(notice(view())).toBeUndefined();
    expect(texts(view())).not.toContain('accessTitle:Sales line');
    expect(toast.error).toHaveBeenCalledWith('accessChanged:Sales line');
  });

  it('a save does not close the dialog of another number', async () => {
    numbers = [number(), number({ id: 'n2', label: 'Other line' })];
    await open();
    tick('BO', true);
    let answer = () => {};
    patchReply = () =>
      new Promise<Reply>((done) => {
        answer = () => done({ status: 200, body: {} });
      });
    await press(view(), 'saveAccess');
    await press(view(), 'cancel');
    const second = findElements(
      view(),
      (el) =>
        !!el.props.onClick &&
        textOf(el.props.children as ReactNode).endsWith('manageAccess')
    )[1];
    (second.props.onClick as () => void)();
    answer();
    await settle();
    await settle();
    expect(texts(view())).toContain('accessTitle:Other line');
  });

  it('only a deactivated person: the card and the dialog say admins only', async () => {
    numbers = [number({ member_ids: ['old'] })];
    await open();
    expect(texts(view())).toContain('adminsOnlyTitle');
    expect(texts(view())).toContain('draftAdminsOnly');
    expect(texts(view())).not.toContain('draftAllocated');
    await press(view(), 'saveAccess');
    expect(toast.success).toHaveBeenCalledWith('accessAdminsOnly:Sales line');
  });

  it('only teams nobody can use: admins only, also in the toast', async () => {
    teams = [team({ member_ids: ['old'] })];
    numbers = [
      number({ member_ids: [], team_ids: ['t1'], team_member_ids: ['old'] }),
    ];
    await open();
    expect(texts(view())).toContain('teamsEmptyShared');
    expect(texts(view())).toContain('draftTeamsEmptyShared');
    await press(view(), 'saveAccess');
    expect(toast.success).toHaveBeenCalledWith('accessAdminsOnly:Sales line');
  });

  it('a person who left is not counted', async () => {
    numbers = [number({ member_ids: ['ghost', 'ana'] })];
    await open();
    expect(texts(view())).toContain('allocatedTitle:1');
    expect(texts(view())).toContain('draftAllocated:1');
  });

  it('does not save an empty list while the teams are not loaded', async () => {
    failing = ['/api/account/teams'];
    await open();
    tick('ANA', false);
    expect(texts(view())).toContain('teamsNeeded');
    expect(texts(view())).not.toContain('draftShared');
    expect(button(view(), 'saveAccess').props.disabled).toBe(true);
    await press(view(), 'saveAccess');
    expect(sent).toEqual([]);
    failing = [];
    await press(view(), 'retry');
    await settle();
    expect(button(view(), 'saveAccess').props.disabled).toBe(false);
    expect(texts(view())).toContain('draftShared');
  });
});

describe('the team editor', () => {
  // The tab and, when it opened one, the editor body in the next slots.
  let editorKey: string | null;
  const view = () =>
    render(() => {
      const tab = TeamsTab();
      const sheet = findElements(tab, (el) => el.type === TeamEditorSheet)[0];
      const body = TeamEditorSheet(
        sheet.props as unknown as Parameters<typeof TeamEditorSheet>[0]
      ) as El | null;
      editorKey = body?.key ?? null;
      return body
        ? [tab, (body.type as (p: object) => ReactNode)(body.props)]
        : tab;
    });
  const nameInput = () =>
    findElements(view(), (el) => el.props.id === 'team-name')[0];
  const member = (id: string) =>
    findElements(view(), (el) => el.props.id === `team-member-${id}`)[0];
  async function open() {
    view();
    await settle();
    const row = findElements(view(), (el) => !!el.props.onEdit)[0];
    (row.props.onEdit as () => void)();
    (nameInput().props.onChange as (e: object) => void)({
      target: { value: 'Sales two' },
    });
    (member('bo').props.onCheckedChange as (v: boolean) => void)(true);
  }
  const changed = () => {
    teams = [team({ member_ids: [] })];
    return { status: 409, body: { code: 'members_changed' } };
  };

  it('keeps the name and ticks after a 409 until Reload', async () => {
    await open();
    const key = (view(), editorKey);
    patchReply = changed;
    await press(view(), 'save');
    await settle();
    expect(notice(view()).props.text).toBe('membersChangedStored:noMembers');
    expect(editorKey).toBe(key);
    expect(nameInput().props.value).toBe('Sales two');
    expect(member('bo').props.checked).toBe(true);
    expect(button(view(), 'save').props.disabled).toBe(true);
    await reload(view());
    expect(notice(view())).toBeUndefined();
    expect(nameInput().props.value).toBe('Sales');
    expect(member('ana').props.checked).toBe(false);
    (member('bo').props.onCheckedChange as (v: boolean) => void)(true);
    await press(view(), 'save');
    expect(sent[1].expected_member_ids).toEqual([]);
  });

  it('says a failed read in the notice, with a Retry', async () => {
    await open();
    patchReply = () => {
      failing = ['/api/account/members'];
      return changed();
    };
    await press(view(), 'save');
    await settle();
    expect(notice(view()).props).toMatchObject({
      text: 'membersChangedUnread',
      label: 'retry',
    });
    failing = [];
    await reload(view());
    expect(notice(view()).props.text).toBe('membersChangedStored:noMembers');
    expect(nameInput().props.value).toBe('Sales two');
  });

  it('an editor closed while the save ran stays closed', async () => {
    await open();
    let answer = () => {};
    patchReply = () =>
      new Promise<Reply>((done) => {
        answer = () => done(changed());
      });
    await press(view(), 'save');
    await press(view(), 'changeInNumbers');
    vi.stubGlobal('window', {
      location: { search: '' },
      history: { replaceState: () => {} },
    });
    await press(view(), 'discard');
    answer();
    await settle();
    await settle();
    view();
    expect(editorKey).toBeNull();
    expect(toast.error).toHaveBeenCalledWith('membersChanged:Sales');
  });

  it('asks which numbers a save would leave to admins', async () => {
    await open();
    (member('bo').props.onCheckedChange as (v: boolean) => void)(false);
    (member('ana').props.onCheckedChange as (v: boolean) => void)(false);
    const warning = findElements(
      view(),
      (el) => el.type === NumbersLeftToAdmins && el.props.as === undefined
    )[0];
    expect(warning.props.leaving).toMatchObject({
      team: { id: 't1', member_ids: [], leader_user_id: null },
    });
  });
});

it('names the numbers a team saved without people leaves to admins', async () => {
  numbers = [
    number({ member_ids: [], team_ids: ['t1'], team_member_ids: ['ana'] }),
    number({ id: 'n2', label: 'Other', team_ids: ['t1'] }),
  ];
  const saved = (member_ids: string[]) => () =>
    NumbersLeftToAdmins({
      leaving: {
        team: { id: 't1', name: 'Sales', leader_user_id: null, member_ids },
      },
    });
  render(saved([]));
  await settle();
  expect(texts(render(saved([])))).toBe('leftToAdmins:Sales line');
  expect(texts(render(saved(['old'])))).toBe('leftToAdmins:Sales line');
  expect(render(saved(['bo']))).toBeNull();
});
