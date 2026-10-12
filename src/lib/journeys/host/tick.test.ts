import { readFileSync } from 'node:fs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from 'vitest';
import { newFile } from '../engine';
import type { RunnerEvent } from '../ports';
import type { DrainResult, HandleResult } from '../runner';
import type { WorkflowDef } from '../schema';
import type { JourneyFile, StepResult, Timer } from '../types';
import { SHIPPED_WORKFLOW } from '../workflow';
import { fakeDb, type Reply } from './fake-db';
import { JourneyDbError } from './store';
import { SHIPPED_WORKFLOW_KEY as KEY, runJourneyTick } from './tick';
import type { JourneyTickArgs } from './tick';

const h = vi.hoisted(() => ({
  load: vi.fn(),
  createRunner: vi.fn(),
  createSink: vi.fn(),
}));

vi.mock('../runner', () => ({ createRunner: h.createRunner }));
vi.mock('./sink', () => ({ createJourneySink: h.createSink }));
vi.mock('./consent', () => ({ SupabaseConsentPort: class {} }));
vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  SupabaseJourneyStore: class {
    load = h.load;
  },
}));

type HandleFn = (event: RunnerEvent, now?: string) => Promise<HandleResult>;
type DrainFn = (fileId: string, now?: string) => Promise<DrainResult>;
interface FakeRunner {
  def: WorkflowDef;
  handle: Mock<HandleFn>;
  drain: Mock<DrainFn>;
}

const NOW = new Date('2026-10-12T10:00:00.000Z');
const AT = NOW.toISOString();
const ZERO = {
  accounts: 0,
  timersFired: 0,
  filesDrained: 0,
  delivered: 0,
  dropped: 0,
  errors: 0,
};
const NOTHING_PENDING: DrainResult = { delivered: 0, pending: 0 };

let files: Map<string, JourneyFile>;
let runners: FakeRunner[];
let handleImpl: HandleFn;
let drainImpl: DrainFn;
let warn: MockInstance;
let error: MockInstance;

const ok = (drain: DrainResult = NOTHING_PENDING): HandleResult => ({
  status: 'ok',
  result: {} as StepResult,
  drain,
});
/** The engine's commit, as far as the tick can see it: the fired timer leaves the file. */
const clearTimer = (e: RunnerEvent) => {
  const file = files.get(e.fileId)!;
  if (e.type === 'TIMER')
    files.set(file.id, {
      ...file,
      timers: file.timers.filter(
        (t) => !(t.kind === e.kind && t.fireAt === e.at)
      ),
    });
};

const minutes = (m: number) =>
  new Date(NOW.getTime() + m * 60_000).toISOString();
const timer = (kind: string, m: number): Timer => ({
  kind,
  fireAt: minutes(m),
  state: 'S_WAIT',
});
const putFile = (id: string, ...timers: Timer[]) =>
  files.set(id, {
    ...newFile({ id, contactId: `c-${id}`, workspaceId: 'a1' }),
    timers,
  });

const rows = (...data: Record<string, unknown>[]): Reply => ({ data });
const enabled = (...a: [account_id: string, workflow_key: string][]) =>
  rows(
    ...a.map(([account_id, workflow_key]) => ({ account_id, workflow_key }))
  );
const dueFiles = (...f: [id: string, account_id: string][]) =>
  rows(...f.map(([id, account_id]) => ({ id, account_id })));
const pendingItems = (...f: [file_id: string, account_id: string][]) =>
  rows(...f.map(([file_id, account_id]) => ({ file_id, account_id })));
/** The three listing queries, in the order the tick makes them. */
const lists = (due: Reply = rows(), pending: Reply = rows()) => [due, pending];

async function tick(replies: Reply[], extra: Partial<JourneyTickArgs> = {}) {
  const { db, queries } = fakeDb(...replies);
  const result = await runJourneyTick({ db, now: NOW, ...extra });
  return { result, queries };
}
const firedIds = (r: FakeRunner) => r.handle.mock.calls.map(([e]) => e.id);

beforeEach(() => {
  files = new Map();
  runners = [];
  handleImpl = async (e) => (clearTimer(e), ok());
  drainImpl = async () => NOTHING_PENDING;
  h.load.mockImplementation(async (id: string) => files.get(id) ?? null);
  h.createRunner.mockImplementation(({ def }: { def: WorkflowDef }) => {
    const runner: FakeRunner = {
      def,
      handle: vi.fn<HandleFn>((e, now) => handleImpl(e, now)),
      drain: vi.fn<DrainFn>((id, now) => drainImpl(id, now)),
    };
    runners.push(runner);
    return runner;
  });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

describe('the default workflow key', () => {
  it('is the one migration 086 gives journey_settings, so an untouched account is ticked', () => {
    const sql = readFileSync('supabase/migrations/086_journeys.sql', 'utf8');
    const m = /workflow_key\s+text NOT NULL DEFAULT '([^']+)'/.exec(sql);
    expect(m?.[1]).toBe(KEY);
  });
});

describe('runJourneyTick: which accounts it ticks', () => {
  it('reads only enabled journey settings and scopes both file queries to those accounts', async () => {
    const { result, queries } = await tick([
      enabled(['a1', KEY], ['a2', KEY]),
      ...lists(),
    ]);
    expect(queries[0]).toEqual([
      ['from', 'journey_settings'],
      ['select', 'account_id, workflow_key'],
      ['eq', 'enabled', true],
      ['await'],
    ]);
    expect(queries[1]).toContainEqual(['in', 'account_id', ['a1', 'a2']]);
    expect(queries[2]).toContainEqual(['in', 'account_id', ['a1', 'a2']]);
    expect(result).toEqual({ ...ZERO, accounts: 2 });
  });

  it('does nothing, and queries nothing more, when no account has journeys enabled', async () => {
    const { result, queries } = await tick([enabled()]);
    expect(result).toEqual(ZERO);
    expect(queries).toHaveLength(1);
    expect(h.createRunner).not.toHaveBeenCalled();
  });

  it('skips an account on an unknown workflow with a log line, and still ticks the others', async () => {
    putFile('f2', timer('REMIND', -5));
    const { result, queries } = await tick([
      enabled(['a1', 'ghost.v9'], ['a2', KEY]),
      ...lists(dueFiles(['f2', 'a2'])),
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/account a1.*ghost\.v9/)
    );
    expect(queries[1]).toContainEqual(['in', 'account_id', ['a2']]);
    expect(runners).toHaveLength(1);
    expect(result).toEqual({ ...ZERO, accounts: 1, timersFired: 1 });
  });

  it('ticks nothing, and does not fail, when every enabled account is on an unknown workflow', async () => {
    const { result, queries } = await tick([enabled(['a1', 'ghost.v9'])]);
    expect(result).toEqual(ZERO);
    expect(queries).toHaveLength(1);
    expect(h.createRunner).not.toHaveBeenCalled();
  });

  it('builds one runner per workflow and routes each account to its own', async () => {
    const other = { ...SHIPPED_WORKFLOW, id: 'pos', version: 2 } as WorkflowDef;
    putFile('f1', timer('A', -5));
    putFile('f2', timer('B', -5));
    await tick(
      [
        enabled(['a1', KEY], ['a2', 'pos.v2'], ['a3', KEY]),
        ...lists(
          dueFiles(['f1', 'a1'], ['f2', 'a2']),
          pendingItems(['f3', 'a3'], ['f4', 'a2'])
        ),
      ],
      { workflows: { [KEY]: SHIPPED_WORKFLOW, 'pos.v2': other } }
    );
    expect(runners.map((r) => r.def)).toEqual([SHIPPED_WORKFLOW, other]);
    const [shipped, pos] = runners;
    expect(shipped.handle.mock.calls.map(([e]) => e.fileId)).toEqual(['f1']);
    expect(pos.handle.mock.calls.map(([e]) => e.fileId)).toEqual(['f2']);
    expect(shipped.drain.mock.calls.map(([id]) => id)).toEqual(['f3']);
    expect(pos.drain.mock.calls.map(([id]) => id)).toEqual(['f4']);
    // Each sink reads the tick's clock, not the wall clock.
    for (const [deps] of h.createSink.mock.calls)
      expect(deps.now()).toEqual(NOW);
  });

  it.each([
    ['journey_settings', 0],
    ['journey_files', 1],
    ['journey_outbox', 2],
  ])('fails the tick when the %s listing fails', async (source, at) => {
    const replies: Reply[] = [enabled(['a1', KEY]), ...lists()];
    replies[at] = { error: { message: 'boom', code: '57014' } };
    const failed = tick(replies);
    await expect(failed).rejects.toBeInstanceOf(JourneyDbError);
    await expect(failed).rejects.toMatchObject({ source, code: '57014' });
  });
});

describe('runJourneyTick: timers', () => {
  it('asks for open files whose earliest timer is due, oldest first', async () => {
    const { queries } = await tick([enabled(['a1', KEY]), ...lists()], {
      limit: 7,
    });
    expect(queries[1]).toEqual([
      ['from', 'journey_files'],
      ['select', 'id, account_id'],
      ['in', 'account_id', ['a1']],
      ['is', 'closed_at', null],
      ['lte', 'next_timer_at', AT],
      ['order', 'next_timer_at', { ascending: true }],
      ['limit', 7],
      ['await'],
    ]);
  });

  it('fires a due timer exactly once, as a TIMER event named timer:<kind>:<fireAt>', async () => {
    putFile('f1', {
      kind: 'REMIND',
      fireAt: '2026-10-12T09:55:00.000Z',
      state: 'S_WAIT',
    });
    handleImpl = async (e) => (
      clearTimer(e),
      ok({ delivered: 2, pending: 0, dropped: 1 })
    );
    const { result } = await tick([
      enabled(['a1', KEY]),
      ...lists(dueFiles(['f1', 'a1'])),
    ]);
    const [runner] = runners;
    expect(runner.handle).toHaveBeenCalledTimes(1);
    expect(runner.handle).toHaveBeenCalledWith(
      {
        type: 'TIMER',
        kind: 'REMIND',
        at: '2026-10-12T09:55:00.000Z',
        id: 'timer:REMIND:2026-10-12T09:55:00.000Z',
        fileId: 'f1',
      },
      AT
    );
    expect(result).toEqual({
      ...ZERO,
      accounts: 1,
      timersFired: 1,
      delivered: 2,
      dropped: 1,
    });
    // The file is read once to find the timer and once more to see none is left.
    expect(h.load).toHaveBeenCalledTimes(2);
  });

  it('fires every due timer of a file, earliest first, and never one that is not due yet', async () => {
    putFile('f1', timer('AT_NOW', 0), timer('LATER', 1), timer('EARLIER', -5));
    const { result } = await tick([
      enabled(['a1', KEY]),
      ...lists(dueFiles(['f1', 'a1'])),
    ]);
    expect(firedIds(runners[0])).toEqual([
      `timer:EARLIER:${minutes(-5)}`,
      `timer:AT_NOW:${minutes(0)}`,
    ]);
    expect(files.get('f1')!.timers.map((t) => t.kind)).toEqual(['LATER']);
    expect(result.timersFired).toBe(2);
  });

  it('fires nothing for a file whose timers are all still in the future', async () => {
    putFile('f1', timer('LATER', 1));
    const { result } = await tick([
      enabled(['a1', KEY]),
      ...lists(dueFiles(['f1', 'a1'])),
    ]);
    expect(runners[0].handle).not.toHaveBeenCalled();
    expect(result).toEqual({ ...ZERO, accounts: 1 });
  });

  it('reads the file again before each timer, since firing one can cancel the others', async () => {
    putFile('f1', timer('A', -10), timer('B', -5));
    handleImpl = async (e) => {
      files.set(e.fileId, { ...files.get(e.fileId)!, timers: [] });
      return ok();
    };
    const { result } = await tick([
      enabled(['a1', KEY]),
      ...lists(dueFiles(['f1', 'a1'])),
    ]);
    expect(firedIds(runners[0])).toEqual([`timer:A:${minutes(-10)}`]);
    expect(result.timersFired).toBe(1);
  });

  it.each(['duplicate', 'not_found'] as const)(
    'does not count a %s result as fired, and does not retry that timer this tick',
    async (status) => {
      putFile('f1', timer('REMIND', -5));
      handleImpl = async () => ({ status });
      const { result } = await tick([
        enabled(['a1', KEY]),
        ...lists(dueFiles(['f1', 'a1'])),
      ]);
      expect(runners[0].handle).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ...ZERO, accounts: 1 });
    }
  );

  it('logs a rejected timer without counting it as fired or as an error, and moves on', async () => {
    putFile('f1', timer('REMIND', -5));
    putFile('f2', timer('REMIND', -5));
    handleImpl = async (e) => {
      if (e.fileId === 'f1')
        return {
          status: 'rejected',
          error: { code: 'STALE_TIMER', message: 'REMIND is not pending' },
        };
      clearTimer(e);
      return ok();
    };
    const { result } = await tick([
      enabled(['a1', KEY]),
      ...lists(dueFiles(['f1', 'a1'], ['f2', 'a1'])),
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/file f1.*timer:REMIND:.*REMIND is not pending/)
    );
    expect(runners[0].handle).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ...ZERO, accounts: 1, timersFired: 1 });
  });
});

describe('runJourneyTick: one file failing does not stop the others', () => {
  it('when its timer handling throws', async () => {
    putFile('f1', timer('A', -5));
    putFile('f2', timer('B', -5));
    handleImpl = async (e) => {
      if (e.fileId === 'f1') throw new Error('version conflict');
      clearTimer(e);
      return ok();
    };
    const { result } = await tick([
      enabled(['a1', KEY]),
      ...lists(dueFiles(['f1', 'a1'], ['f2', 'a1'])),
    ]);
    expect(runners[0].handle.mock.calls.map(([e]) => e.fileId)).toEqual([
      'f1',
      'f2',
    ]);
    expect(result).toEqual({ ...ZERO, accounts: 1, timersFired: 1, errors: 1 });
    expect(error).toHaveBeenCalledWith(
      '[journeys] file f1: timer tick failed:',
      'version conflict'
    );
  });

  it('when delivery fails after its timer fired (the timer still counts)', async () => {
    putFile('f1', timer('A', -5));
    putFile('f2', timer('B', -5));
    handleImpl = async (e) => {
      clearTimer(e);
      return ok(
        e.fileId === 'f1'
          ? { delivered: 0, pending: 1, error: new Error('whapi 503') }
          : { delivered: 1, pending: 0 }
      );
    };
    const { result } = await tick([
      enabled(['a1', KEY]),
      ...lists(dueFiles(['f1', 'a1'], ['f2', 'a1'])),
    ]);
    expect(result).toEqual({
      ...ZERO,
      accounts: 1,
      timersFired: 2,
      delivered: 1,
      errors: 1,
    });
    expect(error).toHaveBeenCalledWith(
      '[journeys] file f1: timer tick failed:',
      'whapi 503'
    );
  });

  it.each([
    [
      'reports an error',
      async () => ({ delivered: 0, pending: 1, error: new Error('whapi 503') }),
    ],
    ['throws', async () => Promise.reject(new Error('whapi 503'))],
  ])('when its outbox drain %s', async (_name, failing) => {
    drainImpl = async (id) =>
      id === 'f1' ? failing() : { delivered: 1, pending: 0 };
    const { result } = await tick([
      enabled(['a1', KEY]),
      ...lists(rows(), pendingItems(['f1', 'a1'], ['f2', 'a1'])),
    ]);
    expect(runners[0].drain.mock.calls.map(([id]) => id)).toEqual(['f1', 'f2']);
    expect(result).toMatchObject({ delivered: 1, errors: 1 });
    expect(error).toHaveBeenCalledWith(
      '[journeys] file f1: drain stopped:',
      'whapi 503'
    );
  });
});

describe('runJourneyTick: the outbox drain', () => {
  it('asks for pending items that have no not_before or one that has passed, oldest first', async () => {
    const { queries } = await tick([enabled(['a1', KEY]), ...lists()]);
    expect(queries[2]).toEqual([
      ['from', 'journey_outbox'],
      ['select', 'file_id, account_id'],
      ['in', 'account_id', ['a1']],
      ['eq', 'status', 'pending'],
      ['or', `not_before.is.null,not_before.lte."${AT}"`],
      ['order', 'committed_at', { ascending: true }],
      ['limit', 50],
      ['await'],
    ]);
  });

  it('drains each file with due pending items at the tick time, summing the counts', async () => {
    drainImpl = async (id) =>
      id === 'f1'
        ? { delivered: 2, pending: 0 }
        : { delivered: 1, pending: 1, dropped: 1, deferredUntil: minutes(30) };
    const { result } = await tick([
      enabled(['a1', KEY]),
      ...lists(rows(), pendingItems(['f1', 'a1'], ['f2', 'a1'])),
    ]);
    expect(runners[0].drain.mock.calls).toEqual([
      ['f1', AT],
      ['f2', AT],
    ]);
    expect(result).toEqual({
      ...ZERO,
      accounts: 1,
      filesDrained: 2,
      delivered: 3,
      dropped: 1,
    });
  });

  it('drains a file once however many items it has due', async () => {
    const { result } = await tick([
      enabled(['a1', KEY]),
      ...lists(
        rows(),
        pendingItems(['f1', 'a1'], ['f1', 'a1'], ['f2', 'a1'], ['f1', 'a1'])
      ),
    ]);
    expect(runners[0].drain.mock.calls.map(([id]) => id)).toEqual(['f1', 'f2']);
    expect(result.filesDrained).toBe(2);
  });

  it('does not drain a file again after its timer fired (handle already did)', async () => {
    putFile('f1', timer('A', -5));
    const { result } = await tick([
      enabled(['a1', KEY]),
      ...lists(
        dueFiles(['f1', 'a1']),
        pendingItems(['f1', 'a1'], ['f2', 'a1'])
      ),
    ]);
    expect(runners[0].handle).toHaveBeenCalledTimes(1);
    expect(runners[0].drain.mock.calls.map(([id]) => id)).toEqual(['f2']);
    expect(result).toMatchObject({ timersFired: 1, filesDrained: 1 });
  });
});
