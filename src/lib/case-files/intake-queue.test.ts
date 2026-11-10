import { describe, expect, it, vi } from 'vitest';

import type { IntakePorts } from './intake';
import { caseIntakeQueue } from './intake-queue';

const doc = (groupMessageId: number) => ({
  accountId: 'acc-1',
  contactId: 'contact-1',
  groupId: 'sg-1',
  groupMessageId,
  waMessageId: `wa-${groupMessageId}`,
  kind: 'document' as const,
  media: { filename: 'salary.pdf' },
  caption: null,
  sentAt: '2026-11-10T00:00:00Z',
});

const text = (body: string) => ({
  accountId: 'acc-1',
  groupId: 'sg-1',
  waMessageId: 'wa-t',
  body,
});

function setup() {
  const order: string[] = [];
  const ports = {
    caseInfo: vi.fn(async (caseId: string) => {
      order.push(`caseInfo ${caseId}`);
      return {
        accountId: 'acc-1',
        groupId: 'sg-1',
        coordinatorId: 'co-1',
        closedAt: null,
      };
    }),
    intakeEnabled: vi.fn(async () => false),
  } as unknown as IntakePorts;
  const documentIdFor = vi.fn(async (id: number) => {
    order.push(`doc ${id}`);
    return id === 1 ? 'cd-1' : null;
  });
  const caseIdForGroup = vi.fn(async () => 'case-1');
  const q = caseIntakeQueue({ ports, caseIdForGroup, documentIdFor });
  return { q, ports, order, documentIdFor, caseIdForGroup };
}

describe('caseIntakeQueue', () => {
  it('collects without any I/O and runs events in message order on run()', async () => {
    const s = setup();
    s.q.document(doc(1));
    s.q.text(text('2'));
    expect(s.order).toEqual([]);
    await s.q.run();
    expect(s.order).toEqual(['doc 1', 'caseInfo case-1', 'caseInfo case-1']);
    // One case lookup per group per run.
    expect(s.caseIdForGroup).toHaveBeenCalledTimes(1);
  });

  it('skips a document that was not filed, and a group with no case', async () => {
    const s = setup();
    s.q.document(doc(2));
    await s.q.run();
    expect(s.ports.caseInfo).not.toHaveBeenCalled();

    s.caseIdForGroup.mockResolvedValueOnce(null);
    s.q.document(doc(1));
    await s.q.run();
    expect(s.documentIdFor).toHaveBeenCalledTimes(1);
  });

  it('never throws, and a failure does not stop later events', async () => {
    const s = setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    s.documentIdFor.mockRejectedValueOnce(new Error('boom'));
    s.q.document(doc(1));
    s.q.text(text('1'));
    await expect(s.q.run()).resolves.toBeUndefined();
    err.mockRestore();
    expect(s.ports.caseInfo).toHaveBeenCalledTimes(1);
  });

  it('runs each event once', async () => {
    const s = setup();
    s.q.text(text('1'));
    await s.q.run();
    await s.q.run();
    expect(s.ports.caseInfo).toHaveBeenCalledTimes(1);
  });
});
