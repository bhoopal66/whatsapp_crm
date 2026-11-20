import { describe, expect, it } from 'vitest';
import { MemoryAutoMsgStore, type MemoryContext } from './memory-store';
import { DEFAULT_SETTINGS, type OutboxRow } from './types';

function row(id: string, over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id,
    accountId: 'acc',
    conversationId: 'c1',
    contactId: 'p1',
    trigger: 'stage_hr_interview',
    templateKind: 'hr_interview_invite',
    language: 'en',
    params: {},
    bodyRendered: null,
    dedupeKey: `c1|stage_hr_interview|${id}`,
    status: 'queued',
    holdReason: null,
    attempts: 0,
    claimState: null,
    createdAt: '2026-11-14T09:00:00Z',
    sentAt: null,
    ...over,
  };
}

function store() {
  const ctx = { settings: DEFAULT_SETTINGS } as unknown as MemoryContext;
  return new MemoryAutoMsgStore(ctx, { now: () => new Date() });
}

// Mirrors 212's hr_automsg_fail_terminal.
describe('MemoryAutoMsgStore.failTerminal', () => {
  it('fails a queued, unclaimed row', async () => {
    const s = store();
    s.add(row('a'));
    await s.failTerminal('a', 'rejected');
    const r = s.rows.get('a')!;
    expect(r.status).toBe('failed');
    expect(r.attempts).toBe(3);
    expect(r.claimState).toBeNull();
    expect(s.errors.get('a')).toBe('rejected');
  });

  it('refuses a sent row and a cancelled row', async () => {
    const s = store();
    s.add(row('b', { status: 'sent' }));
    s.add(row('c', { status: 'cancelled' }));
    await expect(s.failTerminal('b', 'x')).rejects.toThrow('ALREADY_DECIDED');
    await expect(s.failTerminal('c', 'x')).rejects.toThrow('ALREADY_DECIDED');
  });

  it('lets a failed receipt fail a sent row', async () => {
    const s = store();
    s.add(row('d', { status: 'sent', deliveryState: 'failed' }));
    await s.failTerminal('d', 'x');
    expect(s.rows.get('d')!.status).toBe('failed');
  });

  it('is NOT_FOUND for a missing row', async () => {
    await expect(store().failTerminal('zz', 'x')).rejects.toThrow('NOT_FOUND');
  });
});
