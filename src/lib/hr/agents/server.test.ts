import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({
  config: vi.fn(),
  optOut: vi.fn(),
  usage: vi.fn(),
  portOpts: null as null | { onUsage?: (u: unknown) => void },
}));
vi.mock('@/lib/ai/config', () => ({
  loadAiConfig: (...a: unknown[]) => h.config(...a),
}));
vi.mock('@/lib/ai/opt-out', () => ({
  markOptedOut: (...a: unknown[]) => h.optOut(...a),
}));
vi.mock('@/lib/ai/usage', () => ({
  logAiUsage: (...a: unknown[]) => h.usage(...a),
}));
vi.mock('./model', async () => {
  const { StubModel } = await import('./stub-model');
  return {
    createAiModelPort: (opts: { onUsage?: (u: unknown) => void }) => {
      h.portOpts = opts;
      const stub = new StubModel();
      return {
        complete: async (input: never) => {
          const out = await stub.complete(input);
          opts.onUsage?.({
            model: 'm-1',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          });
          return out;
        },
      };
    },
  };
});

import { runHrAgents } from './server';
import { StubModel } from './stub-model';

const NOW = new Date('2026-11-16T10:00:00Z');
type Ctx = Record<string, unknown>;
let ctx: Ctx | null;
let messages: Record<string, unknown>[];
let rpcCalls: { fn: string; args: Record<string, unknown> }[];
let draftReply: { data: unknown; error: unknown };
let throwOn: string | null;

function baseCtx(over: Ctx = {}): Ctx {
  return {
    account_id: 'acct-1',
    inbox: 'recruiter',
    stage_key: 'cv_review',
    closed: false,
    reply_state: 'awaiting_us',
    last_inbound_at: '2026-11-16T09:59:00Z',
    contact_id: 'contact-1',
    personal_owner_id: null,
    send_provider: 'whapi',
    opted_out: false,
    pending_drafts: 0,
    drafts_today: 0,
    enabled: {
      orchestrator: true,
      cv_screening: true,
      scheduling: true,
      candidate_faq: true,
      escalation: true,
    },
    ...over,
  };
}

function db(): SupabaseClient {
  const query = () => {
    const q: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};
    for (const m of ['select', 'order', 'lte']) q[m] = () => q;
    q.eq = (col: string, v: unknown) => ((filters[col] = v), q);
    const matching = () =>
      messages.filter((m) =>
        Object.entries(filters).every(([k, v]) => m[k] === v)
      );
    q.maybeSingle = async () => ({ data: matching()[0] ?? null, error: null });
    q.limit = async (n: number) => ({
      data: matching()
        .slice()
        .sort((a, b) =>
          String(b.created_at).localeCompare(String(a.created_at))
        )
        .slice(0, n),
      error: null,
    });
    return q;
  };
  return {
    from: () => query(),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (throwOn === fn) throw new Error('boom');
      if (fn === 'hr_agent_context')
        return { data: ctx ? [ctx] : [], error: null };
      if (fn === 'hr_agent_draft_create') return draftReply;
      return { data: 1, error: null };
    },
  } as unknown as SupabaseClient;
}

function msg(id: string, sender: string, text: string, at: string) {
  return {
    id,
    conversation_id: 'conv-1',
    sender_type: sender,
    content_text: text,
    created_at: at,
  };
}

const call = (fn: string) => rpcCalls.filter((c) => c.fn === fn);
const run = (over: Record<string, unknown> = {}) =>
  runHrAgents(db(), {
    accountId: 'acct-1',
    conversationId: 'conv-1',
    sourceMessageId: 'm-2',
    actorUserId: 'user-1',
    now: NOW,
    model: new StubModel(),
    ...over,
  });

beforeEach(() => {
  ctx = baseCtx();
  messages = [
    msg('m-1', 'agent', 'Hi, thanks for applying', '2026-11-16T09:00:00Z'),
    msg('m-2', 'customer', 'I attached my CV', '2026-11-16T09:59:00Z'),
  ];
  rpcCalls = [];
  draftReply = { data: 'draft-1', error: null };
  throwOn = null;
  h.config.mockReset().mockResolvedValue({ provider: 'openai', model: 'm' });
  h.optOut.mockReset().mockResolvedValue(true);
  h.usage.mockReset().mockResolvedValue(undefined);
  h.portOpts = null;
});

describe('runHrAgents', () => {
  it('stores a draft with created_by and the Whapi window off', async () => {
    const model = new StubModel();
    const r = await run({ model });
    expect(r).toMatchObject({ outcome: 'drafted', draftId: 'draft-1' });
    const [c] = call('hr_agent_draft_create');
    expect(c.args).toMatchObject({
      p_conversation_id: 'conv-1',
      p_source_message_id: 'm-2',
      p_agent_kind: 'cv_screening',
      p_intent: 'cv_received',
      p_created_by: 'user-1',
      p_requires_template: false,
    });
    expect(String(c.args.p_body)).not.toBe('');
    expect(model.calls[0].history.map((x) => x.direction)).toEqual([
      'out',
      'in',
    ]);
  });

  it('applies the 24 h window only on a Meta number', async () => {
    ctx = baseCtx({
      send_provider: 'meta',
      last_inbound_at: '2026-11-14T09:00:00Z',
    });
    const r = await run();
    expect(r.outcome).toBe('handoff');
    expect(call('hr_agent_draft_create')[0].args).toMatchObject({
      p_requires_template: true,
      p_body: '',
    });
    ctx = baseCtx({ last_inbound_at: '2026-11-14T09:00:00Z' });
    rpcCalls = [];
    expect((await run()).outcome).toBe('drafted');
  });

  it('off: nothing stored and no model call', async () => {
    ctx = baseCtx({ enabled: { orchestrator: false } });
    const model = new StubModel();
    expect(await run({ model })).toEqual({ outcome: 'off' });
    expect(model.calls).toHaveLength(0);
    expect(call('hr_agent_draft_create')).toHaveLength(0);
  });

  it.each([
    ['not_tracked', null],
    ['not_tracked', { account_id: 'acct-2' }],
    ['not_recruiter', { inbox: 'dept' }],
    ['closed', { closed: true }],
    ['contact_opted_out', { opted_out: true }],
  ] as const)('%s', async (outcome, over) => {
    ctx = over === null ? null : baseCtx(over);
    expect(await run()).toEqual({ outcome });
    expect(call('hr_agent_draft_create')).toHaveLength(0);
  });

  it('no_message for an unknown or non-customer source message', async () => {
    expect((await run({ sourceMessageId: 'm-1' })).outcome).toBe('no_message');
    messages = [];
    expect((await run({ sourceMessageId: null })).outcome).toBe('no_message');
  });

  it('no_ai when AI is not configured or the key is unreadable', async () => {
    h.config.mockResolvedValueOnce(null);
    expect((await run()).outcome).toBe('no_ai');
    h.config.mockRejectedValueOnce(new Error('decrypt'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await run()).outcome).toBe('no_ai');
    err.mockRestore();
  });

  it('opt-out marks the contact and supersedes its drafts', async () => {
    messages.push(msg('m-3', 'customer', 'STOP', '2026-11-16T09:59:30Z'));
    const r = await run({ sourceMessageId: 'm-3' });
    expect(r.outcome).toBe('opted_out');
    expect(h.optOut).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'acct-1',
      contactId: 'contact-1',
    });
    expect(call('hr_agent_supersede')[0].args).toEqual({
      p_account_id: 'acct-1',
      p_contact_id: 'contact-1',
    });
    expect(call('hr_agent_draft_create')).toHaveLength(0);
  });

  it('cap stores nothing', async () => {
    ctx = baseCtx({ pending_drafts: 3 });
    expect((await run()).outcome).toBe('cap');
    expect(call('hr_agent_draft_create')).toHaveLength(0);
  });

  it('a LIMIT refusal is refused/LIMIT', async () => {
    draftReply = { data: null, error: { message: 'x', hint: 'LIMIT' } };
    expect(await run()).toMatchObject({ outcome: 'refused', code: 'LIMIT' });
  });

  it('an upset candidate is flagged urgent', async () => {
    messages.push(
      msg('m-3', 'customer', 'This is unacceptable', '2026-11-16T09:59:30Z')
    );
    const r = await run({ sourceMessageId: 'm-3' });
    expect(r.flagged).toBe(true);
    expect(call('hr_agent_flag_urgent')[0].args).toEqual({
      p_conversation_id: 'conv-1',
    });
  });

  it("logs each model call's usage with mode 'hr_agent'", async () => {
    const r = await run({ model: undefined });
    expect(r.outcome).toBe('drafted');
    expect(h.usage).toHaveBeenCalled();
    expect(h.usage.mock.calls[0][1]).toMatchObject({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      mode: 'hr_agent',
      provider: 'openai',
      model: 'm-1',
    });
  });

  it('a thrown rpc is error, never a throw', async () => {
    throwOn = 'hr_agent_context';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run()).toEqual({ outcome: 'error' });
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
