import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Screens that load themselves, after a gap in realtime. No DOM here: a
// small stand-in for React's hooks keeps state and effects by position
// and renders again after a state set, so a screen can be called as the
// function it is. Children are elements only, never called.
type Slot = { v?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };
const rt = vi.hoisted(() => ({
  slots: [] as Slot[],
  cursor: 0,
  dirty: false,
  effects: [] as (() => void)[],
}));
vi.mock('react', async (importOriginal) => {
  const slot = (make: () => Slot) => {
    const i = rt.cursor++;
    return (rt.slots[i] ??= make());
  };
  const moved = (s: Slot, deps?: unknown[]) =>
    !deps || !s.deps || deps.some((d, k) => !Object.is(d, s.deps![k]));
  const memo = (fn: () => unknown, deps?: unknown[]) => {
    const s = slot(() => ({}));
    if (moved(s, deps)) Object.assign(s, { v: fn(), deps });
    return s.v;
  };
  return {
    ...(await importOriginal<typeof import('react')>()),
    useState: (init: unknown) => {
      const s = slot(() => ({ v: typeof init === 'function' ? init() : init }));
      return [
        s.v,
        (next: unknown) => {
          const v = typeof next === 'function' ? next(s.v) : next;
          if (Object.is(v, s.v)) return;
          s.v = v;
          rt.dirty = true;
        },
      ];
    },
    useRef: (current: unknown) => slot(() => ({ v: { current } })).v,
    useMemo: memo,
    useCallback: (fn: unknown, deps?: unknown[]) => memo(() => fn, deps),
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      const s = slot(() => ({}));
      if (!moved(s, deps)) return;
      rt.effects.push(() => {
        s.cleanup?.();
        s.deps = deps;
        s.cleanup = effect();
      });
    },
  };
});

const CHAT = '7a1c0f3e-5b2d-4c8e-9f10-2a3b4c5d6e7f';
const auth = {
  accountId: '0b6f1c9e-2d3a-4b5c-8d7e-9f0a1b2c3d4e',
  user: { id: '1c7f2d0f-3e4b-4c6d-9e8f-0a1b2c3d4e5f' },
  accountRole: 'agent',
  profileLoading: false,
};
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => auth }));
vi.mock('@/hooks/use-can', () => ({ useCan: () => false }));
vi.mock('@/hooks/use-whatsapp-numbers', () => {
  const none: never[] = [];
  return {
    useAccountNumbers: () => none,
    useAllNumberAllocations: () => none,
  };
});
vi.mock('@/lib/hr/roles-cache', () => ({
  loadHrRoles: async () => ({ admin: false, recruiter: 'member', dept: null }),
}));
vi.mock('@/components/meetings/use-workspace-members', () => ({
  useMeetingTimeZone: () => 'Asia/Dubai',
}));
vi.mock('@/components/meetings/meeting-form-dialog', () => ({
  MeetingFormDialog: () => null,
}));
vi.mock('@/components/groups/create-group-dialog', () => ({
  CreateGroupDialog: () => null,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({}) }));
vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => 'en',
}));

// What each table (or RPC, or URL path) answers, and how often it was
// asked. A promise holds its answer back until the test gives it.
type Answer = { data?: unknown; error: unknown };
let db: Record<string, Answer | Promise<Answer>> = {};
let reads: Record<string, number> = {};
const ask = (name: string) => {
  reads[name] = (reads[name] ?? 0) + 1;
  return db[name] ?? { data: [], error: null };
};
const BROKEN: Answer = { data: null, error: { message: '503' } };

type Payload = { eventType: string; new?: unknown; old?: unknown };
interface Channel {
  handlers: ((payload: Payload) => void)[];
  status?: (s: string) => void;
}
let channels: Channel[] = [];
vi.mock('@/lib/supabase/client', () => {
  const query = (name: string) => {
    const q: unknown = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === 'then'
            ? (ok: (a: Answer) => unknown, bad?: () => unknown) =>
                Promise.resolve(ask(name)).then(ok, bad)
            : () => q,
      }
    );
    return q;
  };
  return {
    createClient: () => ({
      from: query,
      rpc: query,
      removeChannel: async (c: Channel) => {
        channels = channels.filter((x) => x !== c);
      },
      channel: () => {
        const c: Channel & Record<string, unknown> = { handlers: [] };
        c.on = (_t: string, _f: unknown, fn: Channel['handlers'][0]) => {
          c.handlers.push(fn);
          return c;
        };
        c.subscribe = (fn?: Channel['status']) => {
          c.status = fn;
          channels.push(c);
          return c;
        };
        return c;
      },
    }),
  };
});

import { CalendarView } from '@/components/calendar/calendar-view';
import { GroupsList } from '@/components/groups/groups-list';
import { HrPanel } from '@/components/hr/hr-panel';
import { useConversationEvents } from '@/components/inbox/thread-channel-switcher';
import { useReminderSuggestions } from '@/components/inbox/use-reminder-suggestions';
import { useMyCoordinatorShares } from './use-my-coordinator-shares';
import { usePresence } from './use-presence';

let screen: () => unknown = () => null;
let shown: unknown;
const render = () => {
  for (let i = 0; i < 25; i++) {
    rt.dirty = false;
    rt.cursor = 0;
    shown = screen();
    rt.effects.splice(0).forEach((run) => run());
    if (!rt.dirty) return;
  }
  throw new Error('renders without end');
};
const settle = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 4; i++) {
    if (rt.dirty) render();
    await vi.advanceTimersByTimeAsync(0);
  }
  if (ms) {
    await vi.advanceTimersByTimeAsync(ms);
    await settle();
  }
};
const mount = async (fn: () => unknown) => {
  screen = fn;
  render();
  await settle();
  say('SUBSCRIBED');
  await settle();
};
const unmount = () => rt.slots.splice(0).forEach((s) => s.cleanup?.());
const say = (s: string) => channels.forEach((c) => c.status?.(s));
const event = (p: Payload) => channels.forEach((c) => c.handlers[0]?.(p));
const rejoin = async (ms = 1_000) => {
  await settle(10_000);
  say('CHANNEL_ERROR');
  say('SUBSCRIBED');
  await settle(ms);
};
/** The tab hidden for a minute, then shown: both of its events. */
const hideAndShow = async () => {
  const show = (state: string) => {
    Object.assign(document, { visibilityState: state });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  show('hidden');
  await settle(60_000);
  show('visible');
  window.dispatchEvent(new Event('focus'));
  await settle(1_000);
};
/** Every element and text under `node`, children as given. */
const walk = function* (node: unknown): Generator<unknown> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
  } else {
    yield node;
    if (isValidElement(node)) {
      yield* walk((node.props as { children?: ReactNode }).children);
    }
  }
};
const texts = () => [...walk(shown)].filter((n) => typeof n === 'string');

beforeEach(() => {
  vi.useFakeTimers();
  db = {};
  reads = {};
  channels = [];
  Object.assign(rt, { slots: [], cursor: 0, dirty: false, effects: [] });
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), { visibilityState: 'visible' })
  );
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (t?: number) => clearTimeout(t),
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (t?: number) => clearInterval(t),
    })
  );
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const answer = await ask(input.split('?')[0]);
    if (init?.signal?.aborted) throw new Error('aborted');
    const ok = !answer.error;
    return { ok, status: ok ? 200 : 503, json: async () => answer.data };
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rows = (data: unknown): Answer => ({ data, error: null });

describe.each<[string, () => unknown, string]>([
  ['the presence dots', () => usePresence(), 'member_presence'],
  ['the shared chats', () => useMyCoordinatorShares(), 'my_coordinator_shares'],
  [
    'the reminder chips',
    () => useReminderSuggestions(CHAT, true),
    'message_reminder_suggestions',
  ],
  [
    'the timeline notes',
    () => useConversationEvents(CHAT),
    'conversation_events',
  ],
  [
    'the HR panel',
    () =>
      HrPanel({
        conversationId: CHAT,
        inboxDepartment: 'hr',
        contactName: 'A',
      }),
    'hr_conversations',
  ],
  [
    'the groups list',
    () => GroupsList({ selectedId: null }),
    '/api/whatsapp/groups',
  ],
])('%s', (_name, fn, table) => {
  it('read once at first, again on a rejoin, and once on coming back', async () => {
    db['/api/whatsapp/groups'] = rows({ groups: [] });
    await mount(fn);
    await settle(60_000);
    expect(reads[table]).toBe(1);
    await rejoin();
    expect(reads[table]).toBe(2);
    await hideAndShow();
    expect(reads[table]).toBe(3);
  });

  it('stop with the screen', async () => {
    await mount(fn);
    const held = [...channels];
    unmount();
    held.forEach((c) => c.status?.('CHANNEL_ERROR'));
    held.forEach((c) => c.status?.('SUBSCRIBED'));
    await settle(60_000);
    expect(reads[table]).toBe(1);
  });
});

describe('the presence dots', () => {
  it('show who came online in the gap, and keep what is shown on a failed read', async () => {
    const row = (status: string) =>
      rows([{ user_id: 'u2', status, last_seen_at: new Date().toISOString() }]);
    const dot = () =>
      (shown as ReturnType<typeof usePresence>).getPresence('u2');
    db.member_presence = row('away');
    await mount(() => usePresence());
    expect(dot()).toBe('away');
    db.member_presence = BROKEN;
    await rejoin();
    expect(dot()).toBe('away');
    db.member_presence = row('online');
    await settle(5_000); // the retry
    expect(dot()).toBe('online');
  });
});

describe('the shared chats', () => {
  it('keep what is shown when the read after a gap fails', async () => {
    db.my_coordinator_shares = rows([
      { conversation_id: CHAT, bank_code: 'ADCB' },
    ]);
    await mount(() => useMyCoordinatorShares());
    db.my_coordinator_shares = BROKEN;
    await rejoin();
    expect(reads.my_coordinator_shares).toBe(2);
    expect(shown).toEqual(new Map([[CHAT, 'ADCB']]));
  });

  it('are not read a second time by the Inbox, which sees the same gap', () => {
    const page = path.join(process.cwd(), 'src/app/(dashboard)/inbox/page.tsx');
    expect(readFileSync(page, 'utf8')).toContain(
      'useMyCoordinatorShares(resyncToken)'
    );
  });

  it('are none when the first read fails', async () => {
    db.my_coordinator_shares = BROKEN;
    await mount(() => useMyCoordinatorShares());
    expect(shown).toEqual(new Map());
  });
});

describe('the reminder chips', () => {
  const chip = (status: string) => ({
    id: 's1',
    message_id: 'm1',
    conversation_id: CHAT,
    status,
  });
  const status = () =>
    (shown as ReturnType<typeof useReminderSuggestions>).byMessageId.get('m1')
      ?.status;

  it('drop what was dismissed in the gap, and stay when the read fails', async () => {
    db.message_reminder_suggestions = rows([chip('open')]);
    await mount(() => useReminderSuggestions(CHAT, true));
    db.message_reminder_suggestions = BROKEN;
    await rejoin();
    expect(status()).toBe('open');
    db.message_reminder_suggestions = rows([chip('dismissed')]);
    await settle(5_000);
    expect(status()).toBe('dismissed');
  });

  it.each(['an event', 'an action'])(
    'are not rolled back by a read older than %s',
    async (what) => {
      db.message_reminder_suggestions = rows([chip('open')]);
      await mount(() => useReminderSuggestions(CHAT, true));
      let answer: (a: Answer) => void = () => {};
      db.message_reminder_suggestions = new Promise((r) => (answer = r));
      await rejoin();
      if (what === 'an event') {
        event({ eventType: 'UPDATE', new: chip('added') });
      } else {
        (shown as ReturnType<typeof useReminderSuggestions>).merge(
          chip('added') as never
        );
      }
      answer(rows([chip('open')]));
      await settle();
      expect(status()).toBe('added');
    }
  );
});

describe('the timeline notes', () => {
  const note = (id: string) => ({ id, kind: 'channel_switched' });
  const ids = () =>
    (shown as ReturnType<typeof useConversationEvents>).events.map((e) => e.id);

  it('gain what the gap held, and stay when the read fails', async () => {
    db.conversation_events = rows([note('a')]);
    await mount(() => useConversationEvents(CHAT));
    db.conversation_events = BROKEN;
    await rejoin();
    expect(ids()).toEqual(['a']);
    db.conversation_events = rows([note('a'), note('b')]);
    await settle(5_000);
    expect(ids()).toEqual(['a', 'b']);
  });

  it('keep a note that arrived while the read was in flight', async () => {
    db.conversation_events = rows([note('a')]);
    await mount(() => useConversationEvents(CHAT));
    let answer: (a: Answer) => void = () => {};
    db.conversation_events = new Promise((r) => (answer = r));
    await rejoin();
    event({ eventType: 'INSERT', new: note('b') });
    answer(rows([note('a')]));
    await settle();
    expect(ids()).toEqual(['a', 'b']);
  });

  it("read again for this user's own switch", async () => {
    await mount(() => useConversationEvents(CHAT));
    db.conversation_events = rows([note('a')]);
    (shown as ReturnType<typeof useConversationEvents>).reload();
    await settle();
    expect(ids()).toEqual(['a']);
  });
});

describe('the HR panel', () => {
  const row = (stage_key: string) => ({
    conversation_id: CHAT,
    inbox: 'recruiter',
    stage_key,
    closed_at: null,
  });
  const panel = () =>
    HrPanel({ conversationId: CHAT, inboxDepartment: 'hr', contactName: 'A' });
  const stage = () =>
    (shown as { props: { row: { stage_key: string } | null } } | null)?.props
      .row?.stage_key;

  it('shows the stage moved in the gap, and stays when the read fails', async () => {
    db.hr_conversations = rows(row('new'));
    await mount(panel);
    expect(stage()).toBe('new');
    expect(reads['/api/tasks']).toBe(1);

    db.hr_conversations = BROKEN;
    await rejoin();
    expect(stage()).toBe('new');
    db.hr_conversations = rows(row('screening'));
    db.hr_stage_history = BROKEN;
    await settle(2_500);
    expect(stage()).toBe('new');

    delete db.hr_stage_history;
    await settle(10_000);
    expect(stage()).toBe('screening');
    expect(reads['/api/tasks']).toBe(2);
  });

  it.each([
    ['an event', () => event({ eventType: 'UPDATE', new: row('screening') })],
    [
      'a write of its own',
      () => {
        db.hr_set_topic = rows(row('screening'));
        (shown as { props: { onTopic: (t: string) => void } }).props.onTopic(
          'visa'
        );
      },
    ],
  ])('is not rolled back by a read older than %s', async (_what, change) => {
    db.hr_conversations = rows(row('new'));
    await mount(panel);
    let answer: (a: Answer) => void = () => {};
    db.hr_conversations = new Promise((r) => (answer = r));
    await rejoin();
    change();
    await settle();
    answer(rows(row('new')));
    await settle();
    expect(stage()).toBe('screening');
  });
});

describe('the groups list', () => {
  it('gains what the gap held, and stays when the read fails', async () => {
    const url = '/api/whatsapp/groups';
    const group = (id: string) => ({ id, name: `Group ${id}` });
    const names = () =>
      ['Group a', 'Group b'].filter((n) =>
        [...walk(shown)].some(
          (e) => isValidElement(e) && JSON.stringify(e.props).includes(n)
        )
      );
    db[url] = rows({ groups: [group('a')] });
    await mount(() => GroupsList({ selectedId: null }));
    expect(names()).toEqual(['Group a']);
    db[url] = BROKEN;
    await rejoin();
    expect(names()).toEqual(['Group a']);
    db[url] = rows({ groups: [group('a'), group('b')] });
    await rejoin();
    expect(names()).toEqual(['Group a', 'Group b']);
  });
});

describe('the calendar', () => {
  const FEED = '/api/calendar/feed';
  type Info = { start: Date; end: Date };
  type Source = (
    info: Info,
    ok: (events: unknown[]) => void,
    bad: (e: Error) => void
  ) => void;
  const INFO = {
    start: new Date('2026-11-22T00:00:00Z'),
    end: new Date('2026-11-29T00:00:00Z'),
  };
  const item = (id: string) => ({
    kind: 'event',
    id,
    title: id,
    start: '2026-11-24T08:00:00Z',
    end: '2026-11-24T09:00:00Z',
    allDay: false,
  });
  let onGrid: number[] = [];
  let failed = 0;
  const open = async () => {
    onGrid = [];
    failed = 0;
    await mount(() => CalendarView({ refreshSignal: 0 }));
    // FullCalendar's part: it asks the source for its range, at first
    // and on refetchEvents.
    const grid = [...walk(shown)].find(
      (n) => isValidElement(n) && 'events' in (n.props as object)
    ) as { props: { events: Source; ref: { current: unknown } } };
    const refetchEvents = () =>
      grid.props.events(
        INFO,
        (events) => onGrid.push(events.length),
        () => (failed += 1)
      );
    grid.props.ref.current = { getApi: () => ({ refetchEvents }) };
    refetchEvents();
    await settle();
  };
  const feedReads = () =>
    Object.entries(reads).find(([k]) => k.startsWith('/api/calendar'))?.[1];

  it('reads once at first, again on a rejoin, and once on coming back', async () => {
    db[FEED] = rows({ items: [item('a')] });
    await open();
    expect([feedReads(), onGrid]).toEqual([1, [1]]);
    db[FEED] = rows({ items: [item('a'), item('b')] });
    await rejoin();
    expect([feedReads(), onGrid]).toEqual([2, [1, 2]]);
    await hideAndShow();
    expect(feedReads()).toBe(3);
  });

  it('reads once on coming back when the focus comes first', async () => {
    db[FEED] = rows({ items: [item('a')] });
    await open();
    Object.assign(document, { visibilityState: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await settle(60_000);
    window.dispatchEvent(new Event('focus'));
    Object.assign(document, { visibilityState: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await settle(1_000);
    expect(feedReads()).toBe(2);
  });

  it('leaves the read to a slow catch-up when the tab is focused', async () => {
    db[FEED] = rows({ items: [item('a')] });
    await open();
    let answer: (a: Answer) => void = () => {};
    db[FEED] = new Promise((r) => (answer = r));
    await hideAndShow();
    expect(feedReads()).toBe(2);
    answer(rows({ items: [] }));
    await settle();
    expect(onGrid).toEqual([1, 0]);
  });

  it('drops a read of the grid older than the catch-up', async () => {
    let older: (a: Answer) => void = () => {};
    db[FEED] = new Promise((r) => (older = r));
    await open();
    db[FEED] = rows({ items: [item('a'), item('b')] });
    await rejoin();
    expect(onGrid).toEqual([2]);
    older(rows({ items: [item('a')] }));
    await settle();
    expect(onGrid).toEqual([2]);
  });

  it('keeps the events, with no error over them, when that read fails', async () => {
    db[FEED] = rows({ items: [item('a')] });
    await open();
    db[FEED] = BROKEN;
    await rejoin();
    expect([feedReads(), onGrid, failed]).toEqual([2, [1], 0]);
    expect(texts()).not.toContain('loadFailed');
  });

  it('drops a read older than a change of its own', async () => {
    db[FEED] = rows({ items: [item('a')] });
    await open();
    let answer: (a: Answer) => void = () => {};
    db[FEED] = new Promise((r) => (answer = r));
    await rejoin();
    db[FEED] = rows({ items: [item('a'), item('b')] });
    event({ eventType: 'INSERT', new: {} });
    await settle(600); // the debounced refetch
    expect(onGrid).toEqual([1, 2]);
    answer(rows({ items: [item('a')] }));
    await settle();
    expect(onGrid).toEqual([1, 2]);
  });

  it('stops with the screen', async () => {
    db[FEED] = rows({ items: [] });
    await open();
    const held = [...channels];
    unmount();
    held.forEach((c) => c.status?.('CHANNEL_ERROR'));
    held.forEach((c) => c.status?.('SUBSCRIBED'));
    await settle(60_000);
    expect(feedReads()).toBe(1);
  });
});
