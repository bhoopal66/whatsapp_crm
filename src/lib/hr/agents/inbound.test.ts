import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  hrRow: null as Record<string, unknown> | null,
  orchestrator: null as { enabled: boolean } | null,
  rpcs: [] as { fn: string; args: unknown }[],
  froms: [] as string[],
  run: vi.fn(),
  throwFrom: false,
}));

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      h.froms.push(table);
      if (h.throwFrom) throw new Error('db down');
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({
        data: table === 'hr_conversations' ? h.hrRow : h.orchestrator,
        error: null,
      });
      return q;
    },
    rpc: async (fn: string, args: unknown) => {
      h.rpcs.push({ fn, args });
      return { data: 0, error: null };
    },
  }),
}));
vi.mock('./server', () => ({
  runHrAgents: (...a: unknown[]) => h.run(...a),
}));

import { handleHrInboundMessage } from './inbound';

const args = (text: string) => ({
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  messageId: 'row-1',
  text,
});

beforeEach(() => {
  h.hrRow = { account_id: 'acct-1', inbox: 'recruiter', closed_at: null };
  h.orchestrator = { enabled: true };
  h.rpcs = [];
  h.froms = [];
  h.throwFrom = false;
  h.run.mockReset().mockResolvedValue({ outcome: 'drafted' });
});

describe('handleHrInboundMessage', () => {
  it.each([
    ['untracked', null],
    [
      'other account',
      { account_id: 'acct-2', inbox: 'recruiter', closed_at: null },
    ],
  ])('%s: stops after the first read', async (_name, row) => {
    h.hrRow = row;
    await handleHrInboundMessage(args('I sent my CV'));
    expect(h.froms).toEqual(['hr_conversations']);
    expect(h.rpcs).toHaveLength(0);
    expect(h.run).not.toHaveBeenCalled();
  });

  const GATED = [
    ['dept inbox', { account_id: 'acct-1', inbox: 'dept', closed_at: null }],
    ['closed', { account_id: 'acct-1', inbox: 'recruiter', closed_at: 'x' }],
  ] as const;

  it.each(GATED)(
    '%s: other text stops after the first read',
    async (_n, row) => {
      h.hrRow = row;
      await handleHrInboundMessage(args('I sent my CV'));
      expect(h.froms).toEqual(['hr_conversations']);
      expect(h.run).not.toHaveBeenCalled();
    }
  );

  // The pipeline recorded it already (stop.ts).
  it('a STOP reads nothing and runs no agent', async () => {
    await handleHrInboundMessage(args('STOP'));
    expect(h.froms).toEqual([]);
    expect(h.rpcs).toEqual([]);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('normal text with the orchestrator on runs the agents', async () => {
    await handleHrInboundMessage(args('I sent my CV'));
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.run.mock.calls[0][1]).toEqual({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      sourceMessageId: 'row-1',
      actorUserId: null,
    });
  });

  it('normal text with the orchestrator off, or blank text: no run', async () => {
    await handleHrInboundMessage(args('   '));
    h.orchestrator = { enabled: false };
    await handleHrInboundMessage(args('I sent my CV'));
    expect(h.run).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    h.throwFrom = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(handleHrInboundMessage(args('hi'))).resolves.toBeUndefined();
    err.mockRestore();
  });
});
