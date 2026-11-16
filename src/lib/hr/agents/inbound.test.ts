import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  hrRow: null as Record<string, unknown> | null,
  orchestrator: null as { enabled: boolean } | null,
  automsg: false,
  rpcs: [] as { fn: string; args: unknown }[],
  froms: [] as string[],
  run: vi.fn(),
  optOut: vi.fn(),
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
      return { data: fn === 'hr_automsg_active' ? h.automsg : 0, error: null };
    },
  }),
}));
vi.mock('@/lib/ai/opt-out', () => ({
  markOptedOut: (...a: unknown[]) => h.optOut(...a),
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
const rpcNames = () => h.rpcs.map((r) => r.fn);

beforeEach(() => {
  h.hrRow = { account_id: 'acct-1', inbox: 'recruiter', closed_at: null };
  h.orchestrator = { enabled: true };
  h.automsg = false;
  h.rpcs = [];
  h.froms = [];
  h.throwFrom = false;
  h.run.mockReset().mockResolvedValue({ outcome: 'drafted' });
  h.optOut.mockReset().mockResolvedValue(true);
});

describe('handleHrInboundMessage', () => {
  it.each([
    ['untracked', null],
    ['dept inbox', { account_id: 'acct-1', inbox: 'dept', closed_at: null }],
    ['closed', { account_id: 'acct-1', inbox: 'recruiter', closed_at: 'x' }],
    [
      'other account',
      { account_id: 'acct-2', inbox: 'recruiter', closed_at: null },
    ],
  ])('%s: stops after the first read', async (_name, row) => {
    h.hrRow = row;
    await handleHrInboundMessage(args('STOP'));
    expect(h.froms).toEqual(['hr_conversations']);
    expect(h.rpcs).toHaveLength(0);
    expect(h.run).not.toHaveBeenCalled();
    expect(h.optOut).not.toHaveBeenCalled();
  });

  it('STOP with the orchestrator on: opted out + supersede, no run', async () => {
    await handleHrInboundMessage(args('STOP'));
    expect(h.optOut).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'acct-1',
      contactId: 'contact-1',
    });
    expect(rpcNames()).toEqual(['hr_agent_supersede']);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('STOP with agents and automated messages off: nothing', async () => {
    h.orchestrator = { enabled: false };
    await handleHrInboundMessage(args('STOP'));
    expect(h.optOut).not.toHaveBeenCalled();
    expect(rpcNames()).toEqual(['hr_automsg_active']);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('STOP with automated messages on and agents off: opted out', async () => {
    h.orchestrator = null;
    h.automsg = true;
    await handleHrInboundMessage(args('STOP'));
    expect(h.optOut).toHaveBeenCalledTimes(1);
    expect(rpcNames()).toEqual(['hr_automsg_active', 'hr_agent_supersede']);
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
