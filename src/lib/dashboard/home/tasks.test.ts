import { describe, expect, it } from 'vitest';

import type { Task } from '@/lib/tasks/types';
import {
  bucketTasks,
  dueLabel,
  cutTaskCounts,
  limitGroups,
  missedRepeat,
  taskContactIds,
  taskCounts,
  taskTarget,
} from './tasks';

// Local-time constructors keep these independent of the runner's zone.
const local = (d: number, h = 0, mi = 0) => new Date(2026, 9, d, h, mi);
const NOW = local(28, 10, 0); // Wed 28 Oct 2026, 10:00 local

let seq = 0;
function task(due: Date | null, over: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${String(seq).padStart(3, '0')}`,
    account_id: 'a',
    kind: 'manual',
    title: `Task ${seq}`,
    note: null,
    contact_id: null,
    conversation_id: null,
    deal_id: null,
    assigned_to: 'u',
    due_at: due ? due.toISOString() : null,
    status: 'open',
    source: 'manual',
    source_ref: null,
    meta: {},
    created_by: 'u',
    created_at: `2026-10-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
    updated_at: '2026-10-01T00:00:00Z',
    completed_at: null,
    completed_by: null,
    ...over,
  };
}

describe('bucketTasks', () => {
  it('splits on now and the local day boundaries', () => {
    const justPast = task(local(28, 9, 59));
    const laterToday = task(local(28, 23, 59));
    const midnight = task(local(29, 0, 0));
    const lastUpcoming = task(local(4 + 31, 23, 59)); // 4 Nov 23:59
    const firstLater = task(local(5 + 31, 0, 0)); // 5 Nov 00:00
    const undated = task(null);
    const b = bucketTasks(
      [firstLater, undated, lastUpcoming, midnight, laterToday, justPast],
      NOW
    );
    expect(b.overdue).toEqual([justPast]);
    expect(b.today).toEqual([laterToday]);
    expect(b.upcoming).toEqual([midnight, lastUpcoming]);
    expect(b.later).toEqual([firstLater]);
    expect(b.undated).toEqual([undated]);
  });

  it('counts a task due exactly now as today, not overdue', () => {
    const b = bucketTasks([task(NOW)], NOW);
    expect(b.overdue).toHaveLength(0);
    expect(b.today).toHaveLength(1);
  });

  it('orders by due time, most overdue first, ties by creation', () => {
    const older = task(local(20, 8));
    const recent = task(local(28, 8));
    const sameA = task(local(28, 15), { created_at: '2026-10-02T00:00:00Z' });
    const sameB = task(local(28, 15), { created_at: '2026-10-01T00:00:00Z' });
    const b = bucketTasks([recent, sameA, older, sameB], NOW);
    expect(b.overdue).toEqual([older, recent]);
    expect(b.today).toEqual([sameB, sameA]);
  });

  it('orders undated tasks oldest first and skips tasks not open', () => {
    const newer = task(null, { created_at: '2026-10-20T00:00:00Z' });
    const older = task(null, { created_at: '2026-10-10T00:00:00Z' });
    const done = task(local(27), { status: 'done' });
    const b = bucketTasks([newer, done, older], NOW);
    expect(b.undated).toEqual([older, newer]);
    expect(b.overdue).toHaveLength(0);
  });

  it('treats an unparsable due date as undated', () => {
    const b = bucketTasks([task(null, { due_at: 'not a date' })], NOW);
    expect(b.undated).toHaveLength(1);
  });
});

describe('limitGroups', () => {
  it('fills groups in order up to the limit', () => {
    const b = bucketTasks(
      [
        task(local(27)),
        task(local(27, 1)),
        task(local(28, 15)),
        task(local(28, 16)),
        task(local(30)),
      ],
      NOW
    );
    const shown = limitGroups(b, ['overdue', 'today', 'upcoming'], 3);
    expect(shown.map((g) => g.rows.length)).toEqual([2, 1, 0]);
    const all = limitGroups(b, ['overdue', 'today', 'upcoming'], Infinity);
    expect(all.map((g) => g.rows.length)).toEqual([2, 2, 1]);
  });
});

describe('taskCounts', () => {
  it('counts overdue, today and all open', () => {
    const c = taskCounts(
      [
        task(local(27)),
        task(local(28, 9)),
        task(local(28, 18)),
        task(local(30)),
        task(null),
        task(local(27), { status: 'done' }),
      ],
      NOW
    );
    expect(c).toEqual({ overdue: 2, today: 1, open: 5 });
  });
});

describe('cutTaskCounts', () => {
  const overdue = (n: number) =>
    Array.from({ length: n }, (_, i) => task(local(27, 0, i)));

  it('a figure is a floor only when the list ends inside it', () => {
    expect(cutTaskCounts(overdue(4), NOW)).toEqual({
      overdue: 4,
      overdueCut: true,
      today: 0,
      todayCut: true,
    });
    expect(
      cutTaskCounts([...overdue(2), task(local(28, 18))], NOW)
    ).toMatchObject({
      overdue: 2,
      overdueCut: false,
      today: 1,
      todayCut: true,
    });
    expect(
      cutTaskCounts([...overdue(2), task(local(28, 18)), task(local(30))], NOW)
    ).toMatchObject({ overdueCut: false, today: 1, todayCut: false });
    expect(cutTaskCounts([], NOW)).toMatchObject({
      overdueCut: false,
      todayCut: false,
    });
  });
});

describe('dueLabel', () => {
  it('words overdue time in minutes, hours, then days', () => {
    expect(dueLabel(task(local(28, 9, 30)), NOW)).toEqual({
      kind: 'overdue',
      amount: 30,
      unit: 'minute',
    });
    expect(dueLabel(task(local(28, 7, 59)), NOW)).toEqual({
      kind: 'overdue',
      amount: 2,
      unit: 'hour',
    });
    expect(dueLabel(task(local(25, 9)), NOW)).toEqual({
      kind: 'overdue',
      amount: 3,
      unit: 'day',
    });
  });

  it('gives a time today, a weekday this week, a date beyond', () => {
    expect(dueLabel(task(local(28, 14, 30)), NOW).kind).toBe('time');
    expect(dueLabel(task(local(29, 9)), NOW).kind).toBe('weekday');
    expect(dueLabel(task(local(4 + 31, 9)), NOW).kind).toBe('weekday');
    expect(dueLabel(task(local(5 + 31, 9)), NOW).kind).toBe('date');
    expect(dueLabel(task(null), NOW)).toEqual({ kind: 'none' });
  });
});

describe('missedRepeat', () => {
  it('reads folded misses on missed-call tasks only', () => {
    const missed = { kind: 'missed_call' as const };
    expect(missedRepeat({ ...missed, meta: { missed_count: 3 } })).toBe(3);
    expect(missedRepeat({ ...missed, meta: { missed_count: 1 } })).toBeNull();
    expect(missedRepeat({ ...missed, meta: { missed_count: '4' } })).toBeNull();
    expect(missedRepeat({ ...missed, meta: {} })).toBeNull();
    expect(
      missedRepeat({ kind: 'callback', meta: { missed_count: 3 } })
    ).toBeNull();
  });
});

describe('taskTarget and taskContactIds', () => {
  it('links the contact, else the chat, else nothing', () => {
    expect(taskTarget({ contact_id: 'c1', conversation_id: 'v1' })).toEqual({
      href: '/contacts/c1',
      kind: 'contact',
    });
    expect(taskTarget({ contact_id: null, conversation_id: 'v1' })).toEqual({
      href: '/inbox?c=v1',
      kind: 'conversation',
    });
    expect(taskTarget({ contact_id: null, conversation_id: null })).toBeNull();
  });

  it('collects each contact once', () => {
    const ids = taskContactIds([
      task(null, { contact_id: 'b' }),
      task(null, { contact_id: 'a' }),
      task(null, { contact_id: 'b' }),
      task(null),
    ]);
    expect(ids).toEqual(['a', 'b']);
  });
});
