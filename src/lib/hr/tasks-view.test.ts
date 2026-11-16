import { describe, expect, it } from 'vitest';

import type { Task } from '@/lib/tasks/types';

import { isHrTask, isOverdue, visibleHrTasks } from './tasks-view';

const NOW = Date.parse('2026-11-16T12:00:00Z');

function task(over: Partial<Task>): Task {
  return {
    id: 't',
    account_id: 'a',
    kind: 'follow_up',
    title: 'Review CV',
    note: null,
    contact_id: null,
    conversation_id: 'c1',
    deal_id: null,
    assigned_to: 'me',
    due_at: null,
    status: 'open',
    source: 'automation',
    source_ref: 'hr:c1:stage:cv_review:0',
    meta: {},
    created_by: null,
    created_at: '2026-11-16T00:00:00Z',
    updated_at: '2026-11-16T00:00:00Z',
    completed_at: null,
    completed_by: null,
    ...over,
  };
}

describe('isHrTask', () => {
  it('needs an automation source and an hr: ref', () => {
    expect(isHrTask(task({}))).toBe(true);
    expect(isHrTask(task({ source: 'manual' }))).toBe(false);
    expect(isHrTask(task({ source_ref: 'journey:1' }))).toBe(false);
    expect(isHrTask(task({ source_ref: null }))).toBe(false);
  });
});

describe('isOverdue', () => {
  it('is open and past due only', () => {
    expect(isOverdue(task({ due_at: '2026-11-16T11:59:00Z' }), NOW)).toBe(true);
    expect(isOverdue(task({ due_at: '2026-11-16T12:01:00Z' }), NOW)).toBe(
      false
    );
    expect(isOverdue(task({ due_at: null }), NOW)).toBe(false);
    expect(
      isOverdue(task({ due_at: '2026-11-15T00:00:00Z', status: 'done' }), NOW)
    ).toBe(false);
  });
});

describe('visibleHrTasks', () => {
  const late = task({ id: 'late', due_at: '2026-11-16T08:00:00Z' });
  const soon = task({
    id: 'soon',
    due_at: '2026-11-16T14:00:00Z',
    assigned_to: 'other',
  });
  const undatedOld = task({ id: 'u-old', created_at: '2026-11-10T00:00:00Z' });
  const undatedNew = task({ id: 'u-new', created_at: '2026-11-15T00:00:00Z' });
  const done = task({ id: 'done', status: 'done' });
  const manual = task({ id: 'manual', source: 'manual', source_ref: null });
  const all = [undatedOld, soon, done, manual, undatedNew, late];
  const base = { mine: false, overdueOnly: false, userId: 'me', now: NOW };

  it('keeps open HR tasks, soonest due first, undated last and newest first', () => {
    expect(visibleHrTasks(all, base).map((t) => t.id)).toEqual([
      'late',
      'soon',
      'u-new',
      'u-old',
    ]);
  });
  it('filters to mine and to overdue', () => {
    expect(
      visibleHrTasks(all, { ...base, mine: true }).map((t) => t.id)
    ).toEqual(['late', 'u-new', 'u-old']);
    expect(
      visibleHrTasks(all, { ...base, overdueOnly: true }).map((t) => t.id)
    ).toEqual(['late']);
  });
});
