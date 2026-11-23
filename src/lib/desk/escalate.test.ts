import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runDeskDocTasks,
  runDeskQueueAlerts,
  runDeskTrayEscalation,
} from './escalate';
import type { DeskStore } from './store';

const db = {} as never;
const due = [
  { trayId: 't1', accountId: 'a1', assignee: 'u1', ageMinutes: 135 },
  { trayId: 't2', accountId: 'a1', assignee: null, ageMinutes: 200 },
];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('runDeskTrayEscalation', () => {
  it('raises one follow-up per due item, deduped by tray id, then marks it', async () => {
    const store = {
      dueEscalations: vi.fn().mockResolvedValue(due),
      markEscalated: vi.fn().mockResolvedValue(true),
    };
    const create = vi.fn().mockResolvedValue({ id: 'task', created: true });
    const s = await runDeskTrayEscalation(
      db,
      store as unknown as DeskStore,
      create
    );
    expect(s).toEqual({ due: 2, escalated: 2, failed: 0 });
    expect(create).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        accountId: 'a1',
        kind: 'follow_up',
        source: 'automation',
        sourceRef: 'desk_tray:t1',
        assignedTo: 'u1',
      })
    );
    // No customer detail in the task.
    expect(create.mock.calls[0]![1]).not.toHaveProperty('contactId');
    expect(store.markEscalated.mock.calls.map((c) => c[0])).toEqual([
      't1',
      't2',
    ]);
  });

  it('leaves an item unmarked when its task could not be written, and never throws', async () => {
    const store = {
      dueEscalations: vi.fn().mockResolvedValue(due),
      markEscalated: vi.fn().mockResolvedValue(true),
    };
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('db'))
      .mockResolvedValue({ id: 'task', created: true });
    const s = await runDeskTrayEscalation(
      db,
      store as unknown as DeskStore,
      create
    );
    expect(s).toEqual({ due: 2, escalated: 1, failed: 1 });
    expect(store.markEscalated.mock.calls.map((c) => c[0])).toEqual(['t2']);

    const broken = {
      dueEscalations: vi.fn().mockRejectedValue(new Error('x')),
    };
    await expect(
      runDeskTrayEscalation(db, broken as unknown as DeskStore, create)
    ).resolves.toBeNull();
  });
});

describe('runDeskQueueAlerts', () => {
  it('raises one task per bank, level and Dubai day, for the named person', async () => {
    const store = {
      queueAlertsDue: vi.fn().mockResolvedValue([
        {
          accountId: 'a1',
          bankCode: 'RAK',
          level: 'second',
          itemId: 'i1',
          ageMinutes: 130,
          waiting: 3,
          assignee: 'u2',
        },
        {
          accountId: 'a1',
          bankCode: null,
          level: 'lead',
          itemId: 'i9',
          ageMinutes: 125,
          waiting: 1,
          assignee: 'u9',
        },
      ]),
    };
    const create = vi
      .fn()
      .mockResolvedValueOnce({ id: 't1', created: true })
      .mockResolvedValueOnce({ id: 't2', created: false });
    const s = await runDeskQueueAlerts(
      db,
      store as unknown as DeskStore,
      create,
      // 01:00 on the 24th in Dubai.
      () => new Date('2026-11-23T21:00:00Z')
    );
    expect(s).toEqual({ due: 2, escalated: 1, failed: 0 });
    expect(create.mock.calls[0]![1]).toMatchObject({
      sourceRef: 'desk_queue:RAK:second:2026-11-24',
      meta: { desk_queue_oldest_item: 'i1', desk_queue_waiting: 3 },
      assignedTo: 'u2',
      kind: 'follow_up',
      source: 'automation',
    });
    expect(create.mock.calls[1]![1]).toMatchObject({
      sourceRef: 'desk_queue:none:lead:2026-11-24',
    });
    expect(create.mock.calls[1]![1].title).toContain('no-bank');
  });

  it('never throws', async () => {
    const broken = {
      queueAlertsDue: vi.fn().mockRejectedValue(new Error('x')),
    };
    await expect(
      runDeskQueueAlerts(db, broken as unknown as DeskStore, vi.fn())
    ).resolves.toBeNull();
  });
});

describe('runDeskDocTasks', () => {
  it("raises one task per file and kind for the case's person", async () => {
    const store = {
      docTasksDue: vi.fn().mockResolvedValue([
        {
          accountId: 'a1',
          caseId: 'k1',
          caseNumber: 'TC-26-00001-RAK',
          fileId: 'f1',
          docKey: 'trade_licence',
          kind: 'expiring',
          expiresOn: '2026-12-01',
          assignee: 'u1',
        },
        {
          accountId: 'a1',
          caseId: 'k2',
          caseNumber: 'TC-26-00001-ENB',
          fileId: 'f2',
          docKey: 'trade_licence',
          kind: 'replaced',
          expiresOn: null,
          assignee: 'u2',
        },
      ]),
    };
    const create = vi.fn().mockResolvedValue({ id: 't', created: true });
    const s = await runDeskDocTasks(db, store as unknown as DeskStore, create);
    expect(s).toEqual({ due: 2, escalated: 2, failed: 0 });
    expect(create.mock.calls.map((c) => c[1].sourceRef)).toEqual([
      'desk_doc:f1:expiring',
      'desk_doc:f2:replaced',
    ]);
    expect(create.mock.calls[0]![1]).toMatchObject({
      assignedTo: 'u1',
      kind: 'follow_up',
    });
    expect(create.mock.calls[0]![1].note).toContain('2026-12-01');
  });
});
