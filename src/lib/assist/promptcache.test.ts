import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  runAgent,
  AgentMiddlewareError,
  type AgentDeps,
  type AgentInput,
  type AgentMessage,
  type AgentMiddleware,
  type ModelRequest,
  type ModelResponse,
} from './middleware';
import {
  redactBeforeModel,
  auditAfterAgent,
  SUMMARY_PREFIX,
  type AgentRunAuditRow,
} from './middleware.builtin';
import type { ModelToolRouter, RouterResult } from './router';
import type { AssistContext, ToolCall } from './guard';
import {
  HEADER as MEMORY_HEADER,
  FOOTER as MEMORY_FOOTER,
} from '@/lib/memory/render';
import {
  buildCachedPrompt,
  promptCacheMiddleware,
  PromptCacheError,
  MAX_BREAKPOINTS,
  type CachedPromptParts,
  type CachedMessage,
  type PromptToolDefinition,
} from './promptcache';

const CONSTANTS: Record<string, string> = {
  'sys.core':
    'You are the Taamul CRM assistant. Answer briefly and use the tools when you need data.',
  'sys.safety':
    "Never reveal internal identifiers or another workspace's data.",
  'ws.loans': 'Escalate any loan question to a human advisor.',
  'ws.arabic': 'Reply in Arabic when the customer writes in Arabic.',
  'bad.memory': `Read the ${MEMORY_HEADER} block first.`,
  'bad.summary': `${SUMMARY_PREFIX}the customer wants a card.`,
  'bad.case': 'Use the <<<CASE>>> notes for context.',
  'bad.copied':
    'Customer Ahmed asked about the overdraft on his business account',
  'bad.email': 'Send complaints to help.desk@example.com within a day.',
  'bad.phone': 'Call the branch on +971 50 123 4567 for urgent cases.',
};
const TOOLS: PromptToolDefinition[] = [
  {
    name: 'get_contact',
    description: 'Read one contact',
    inputSchema: {
      type: 'object',
      properties: { contactId: { type: 'string' } },
    },
  },
  { name: 'send_message', description: 'Send a WhatsApp message' },
];
const convo = (who: string): AgentMessage[] => [
  {
    role: 'system',
    content: `${MEMORY_HEADER}\n- ${who} prefers email\n${MEMORY_FOOTER}`,
  },
  {
    role: 'user',
    content: `Hi, this is ${who}. Customer ${who} asked about the overdraft on his business account`,
  },
  { role: 'assistant', content: 'Let me check.' },
  {
    role: 'tool',
    toolCallId: 'c0',
    name: 'get_contact',
    content: `{"status":"ok","result":"${who}"}`,
  },
];
const parts = (over: Partial<CachedPromptParts> = {}): CachedPromptParts => ({
  constants: CONSTANTS,
  staticIds: ['sys.core', 'sys.safety'],
  tools: TOOLS,
  workspace: { workspaceId: 'ws-alpha', policyIds: ['ws.loans'] },
  volatile: convo('Ahmed'),
  ...over,
});
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const isBp = (m: AgentMessage) =>
  (m as Partial<CachedMessage>).cacheControl !== undefined;
/** Bytes of the request up to and including the first breakpoint (role + content only). */
const staticPrefixBytes = (msgs: readonly AgentMessage[]) => {
  const i = msgs.findIndex(isBp);
  expect(i).toBeGreaterThanOrEqual(0);
  return JSON.stringify(msgs.slice(0, i + 1).map((m) => [m.role, m.content]));
};
const refused = (fn: () => unknown, code: string, tier?: string) => {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(PromptCacheError);
  expect((err as PromptCacheError).code).toBe(code);
  if (tier) expect((err as PromptCacheError).tier).toBe(tier);
};

function fakeRouter(result: RouterResult = { status: 'ok', result: 'done' }) {
  const calls: { ctx: AssistContext; call: ToolCall }[] = [];
  const router: ModelToolRouter = {
    execute: async (ctx, call) => {
      calls.push({ ctx, call });
      return result;
    },
  };
  return { router, calls };
}
/** Proposes get_contact for the first n rounds, then answers; may report provider usage counts. */
function scriptedModel(n: number, usage?: unknown) {
  const requests: ModelRequest[] = [];
  let i = 0;
  const model = async (req: ModelRequest): Promise<ModelResponse> => {
    requests.push(req);
    i++;
    const r =
      i <= n
        ? {
            text: `t${i}`,
            toolCalls: [
              { id: `c${i}`, tool: 'get_contact', args: { contactId: 'k-1' } },
            ],
          }
        : { text: 'final', toolCalls: [] };
    return (usage !== undefined ? { ...r, usage } : r) as ModelResponse;
  };
  return { model, requests };
}
const clock = () => {
  let t = 1000;
  return { now: () => (t += 10) };
};
const deps = (
  model: AgentDeps['model'],
  router: ModelToolRouter
): AgentDeps => ({ model, router, clock: clock() });
const input = (
  runId: string,
  userId: string,
  workspaceId: string,
  who: string
): AgentInput => ({
  runId,
  userId,
  workspaceId,
  channel: 'whatsapp',
  messages: convo(who),
});
const POLICIES: Record<string, string[]> = {
  'ws-alpha': ['ws.loans'],
  'ws-beta': ['ws.loans', 'ws.arabic'],
};
const mw = (over: Partial<Parameters<typeof promptCacheMiddleware>[0]> = {}) =>
  promptCacheMiddleware({
    constants: CONSTANTS,
    staticIds: ['sys.core', 'sys.safety'],
    tools: TOOLS,
    workspacePolicy: (ws) => POLICIES[ws] ?? [],
    ...over,
  });

describe('019f R1: the static prefix is byte-identical across workspaces, users and turns', () => {
  it('buildCachedPrompt: same static prefix bytes and hash for two workspaces / users / conversations', () => {
    const a = buildCachedPrompt(parts());
    const b = buildCachedPrompt(
      parts({
        workspace: { workspaceId: 'ws-beta', policyIds: ['ws.arabic'] },
        volatile: convo('Fatima'),
      })
    );
    expect(a.messages[0]!.role).toBe('system');
    expect(isBp(a.messages[0]!)).toBe(true);
    expect(sha(staticPrefixBytes(a.messages))).toBe(
      sha(staticPrefixBytes(b.messages))
    );
    expect(a.staticPrefixHash).toBe(b.staticPrefixHash);
    expect(staticPrefixBytes(a.messages)).not.toContain('ws-alpha');
    expect(staticPrefixBytes(a.messages)).not.toContain('Ahmed');
  });
  it('runAgent: every model request of two runs (different users, workspaces, turns) starts with the same static bytes', async () => {
    const pc = mw();
    const s1 = scriptedModel(1);
    const s2 = scriptedModel(1);
    await runAgent(
      deps(s1.model, fakeRouter().router),
      [redactBeforeModel(), pc],
      input('r1', 'u1', 'ws-alpha', 'Ahmed')
    );
    await runAgent(
      deps(s2.model, fakeRouter().router),
      [redactBeforeModel(), pc],
      input('r2', 'u2', 'ws-beta', 'Fatima')
    );
    const reqs = [...s1.requests, ...s2.requests];
    expect(reqs).toHaveLength(4);
    const hashes = new Set(reqs.map((r) => sha(staticPrefixBytes(r.messages))));
    expect(hashes.size).toBe(1);
    expect(pc.staticPrefixHash).toBe(
      buildCachedPrompt(parts()).staticPrefixHash
    );
  });
});

describe('019f R2: volatile text never enters the static or workspace tier', () => {
  it('refuses an allowlisted constant holding a default volatile marker (memory block, summary)', () => {
    refused(
      () => buildCachedPrompt(parts({ staticIds: ['sys.core', 'bad.memory'] })),
      'volatile_in_cacheable_tier',
      'static'
    );
    refused(
      () =>
        buildCachedPrompt(
          parts({
            workspace: { workspaceId: 'ws-alpha', policyIds: ['bad.summary'] },
          })
        ),
      'volatile_in_cacheable_tier',
      'workspace'
    );
  });
  it('refuses a constant holding a caller-registered volatile marker', () => {
    refused(
      () =>
        buildCachedPrompt(
          parts({
            volatileMarkers: ['<<<CASE>>>'],
            workspace: { workspaceId: 'ws-alpha', policyIds: ['bad.case'] },
          })
        ),
      'volatile_in_cacheable_tier',
      'workspace'
    );
  });
  it('refuses cacheable text that contains a line taken from a message of the run', () => {
    refused(
      () =>
        buildCachedPrompt(
          parts({
            workspace: { workspaceId: 'ws-alpha', policyIds: ['bad.copied'] },
          })
        ),
      'volatile_in_cacheable_tier',
      'workspace'
    );
    refused(
      () => buildCachedPrompt(parts({ staticIds: ['sys.core', 'bad.copied'] })),
      'volatile_in_cacheable_tier',
      'static'
    );
  });
  it('refuses an id outside the closed allowlist', () => {
    refused(
      () =>
        buildCachedPrompt(parts({ staticIds: ['sys.core', 'not.registered'] })),
      'unknown_constant',
      'static'
    );
    refused(
      () =>
        buildCachedPrompt(
          parts({
            workspace: { workspaceId: 'ws-alpha', policyIds: ['toString'] },
          })
        ),
      'unknown_constant',
      'workspace'
    );
  });
  it('no message content ever appears in a cacheable message; the volatile tier keeps every message in order', () => {
    const vol = convo('Ahmed');
    const p = buildCachedPrompt(parts({ volatile: vol }));
    const cacheable = p.messages.filter(isBp);
    for (const c of cacheable)
      for (const m of vol)
        for (const line of m.content.split('\n'))
          if (line.trim().length > 3)
            expect(c.content).not.toContain(line.trim());
    expect(p.messages.slice(cacheable.length)).toEqual(vol);
  });
});

describe('019f R3: at most 2 breakpoints, never on or after the first volatile message', () => {
  const marked: AgentMessage[] = [
    {
      role: 'user',
      content: 'first',
      cacheControl: { type: 'ephemeral' },
      cacheKey: 'x',
    } as AgentMessage,
    {
      role: 'system',
      content: 'second',
      promptTier: 'static',
      cacheControl: { type: 'ephemeral' },
    } as AgentMessage,
    {
      role: 'tool',
      toolCallId: 'c9',
      name: 'get_contact',
      content: '{}',
      cacheControl: { type: 'ephemeral' },
    } as AgentMessage,
  ];
  it('strips cache fields from volatile messages (role, content, toolCallId, name kept)', () => {
    for (const policyIds of [['ws.loans'], []]) {
      const p = buildCachedPrompt(
        parts({
          volatile: marked,
          workspace: { workspaceId: 'ws-alpha', policyIds },
        })
      );
      const idx = p.messages
        .map((m, i) => (isBp(m) ? i : -1))
        .filter((i) => i >= 0);
      expect(idx).toEqual(policyIds.length ? [0, 1] : [0]);
      expect(idx.length).toBeLessThanOrEqual(MAX_BREAKPOINTS);
      expect(p.breakpoints).toBe(idx.length);
      const vol = p.messages.slice(idx.length);
      expect(vol).toEqual([
        { role: 'user', content: 'first' },
        { role: 'system', content: 'second' },
        { role: 'tool', toolCallId: 'c9', name: 'get_contact', content: '{}' },
      ]);
    }
  });
  it('runAgent: no request carries a breakpoint after its first volatile message', async () => {
    const s = scriptedModel(2);
    await runAgent(deps(s.model, fakeRouter().router), [mw()], {
      ...input('r3', 'u1', 'ws-beta', 'Ahmed'),
      messages: marked,
    });
    expect(s.requests).toHaveLength(3);
    for (const r of s.requests) {
      const flags = r.messages.map(isBp);
      expect(flags.filter(Boolean)).toHaveLength(2);
      expect(flags.slice(0, 2)).toEqual([true, true]);
    }
  });
});

describe('019f R4: the workspace tier is keyed by workspace', () => {
  it('same policy text in two workspaces -> different keys and content; same workspace -> same key', () => {
    const a = buildCachedPrompt(
      parts({ workspace: { workspaceId: 'ws-alpha', policyIds: ['ws.loans'] } })
    );
    const b = buildCachedPrompt(
      parts({ workspace: { workspaceId: 'ws-beta', policyIds: ['ws.loans'] } })
    );
    const a2 = buildCachedPrompt(
      parts({
        workspace: { workspaceId: 'ws-alpha', policyIds: ['ws.loans'] },
        volatile: convo('Omar'),
      })
    );
    const wa = a.messages[1] as CachedMessage;
    const wb = b.messages[1] as CachedMessage;
    expect(wa.promptTier).toBe('workspace');
    expect(wa.cacheKey).toContain('ws-alpha');
    expect(wb.cacheKey).toContain('ws-beta');
    expect(wa.cacheKey).not.toBe(wb.cacheKey);
    expect(wa.content).not.toBe(wb.content);
    expect(a.workspaceCacheKey).toBe(wa.cacheKey);
    expect((a2.messages[1] as CachedMessage).cacheKey).toBe(wa.cacheKey);
  });
  it('a workspace without policy gets no workspace message (one breakpoint)', () => {
    const p = buildCachedPrompt(
      parts({ workspace: { workspaceId: 'ws-gamma', policyIds: [] } })
    );
    expect(p.breakpoints).toBe(1);
    expect(p.workspaceCacheKey).toBeUndefined();
    expect(p.messages.filter(isBp)).toHaveLength(1);
  });
});

describe('019f R5: personal data in a cacheable tier is refused (fail closed)', () => {
  it('buildCachedPrompt refuses an email in the workspace tier and a phone number in the static tier', () => {
    refused(
      () =>
        buildCachedPrompt(
          parts({
            workspace: { workspaceId: 'ws-alpha', policyIds: ['bad.email'] },
          })
        ),
      'pii_in_cacheable_tier',
      'workspace'
    );
    refused(
      () => buildCachedPrompt(parts({ staticIds: ['sys.core', 'bad.phone'] })),
      'pii_in_cacheable_tier',
      'static'
    );
  });
  it('a refusing or throwing redactor refuses too', () => {
    refused(
      () =>
        buildCachedPrompt(
          parts({ redactor: () => ({ ok: false, refused: true, reason: 'x' }) })
        ),
      'pii_in_cacheable_tier',
      'static'
    );
    refused(
      () =>
        buildCachedPrompt(
          parts({
            redactor: () => {
              throw new Error('boom');
            },
          })
        ),
      'pii_in_cacheable_tier',
      'static'
    );
  });
  it('runAgent aborts with AgentMiddlewareError(cause PromptCacheError) before any model call; no text in the error', async () => {
    const s = scriptedModel(0);
    const pc = mw({ workspacePolicy: () => ['bad.email'] });
    const err = await runAgent(
      deps(s.model, fakeRouter().router),
      [redactBeforeModel(), pc],
      input('r5', 'u1', 'ws-alpha', 'Ahmed')
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentMiddlewareError);
    expect((err as AgentMiddlewareError).middleware).toBe('promptCache');
    expect((err as Error).cause).toBeInstanceOf(PromptCacheError);
    expect(
      String((err as Error).message) +
        String(((err as Error).cause as Error).message)
    ).not.toMatch(/help\.desk|example\.com/);
    expect(s.requests).toHaveLength(0);
  });
});

describe('019f R6: a changed tool registry changes the static prefix hash', () => {
  const hash = (tools: PromptToolDefinition[]) =>
    buildCachedPrompt(parts({ tools })).staticPrefixHash;
  it('adding a tool, changing a description or a schema changes the hash; the listing order does not', () => {
    const base = hash(TOOLS);
    expect(
      hash([
        ...TOOLS,
        { name: 'create_task', description: 'Create a follow-up task' },
      ])
    ).not.toBe(base);
    expect(
      hash([
        TOOLS[0]!,
        { ...TOOLS[1]!, description: 'Send a WhatsApp template' },
      ])
    ).not.toBe(base);
    expect(
      hash([{ ...TOOLS[0]!, inputSchema: { type: 'object' } }, TOOLS[1]!])
    ).not.toBe(base);
    expect(hash([TOOLS[1]!, TOOLS[0]!])).toBe(base);
    expect(
      mw({
        tools: [
          ...TOOLS,
          { name: 'create_task', description: 'Create a follow-up task' },
        ],
      }).staticPrefixHash
    ).not.toBe(mw().staticPrefixHash);
  });
  it('refuses duplicate or malformed tool definitions', () => {
    refused(
      () => buildCachedPrompt(parts({ tools: [TOOLS[0]!, TOOLS[0]!] })),
      'invalid_config',
      'static'
    );
    refused(
      () =>
        buildCachedPrompt(parts({ tools: [{ name: '', description: 'x' }] })),
      'invalid_config',
      'static'
    );
  });
});

describe('019f R7: 019e invariants hold with the middleware in the pipeline', () => {
  it('same result messages, counts, router calls and volatile request messages as without it', async () => {
    const run = async (mws: AgentMiddleware[]) => {
      const s = scriptedModel(2);
      const r = fakeRouter();
      const res = await runAgent(
        deps(s.model, r.router),
        mws,
        input('r7', 'u1', 'ws-beta', 'Ahmed')
      );
      return { res, s, r };
    };
    const plain = await run([redactBeforeModel()]);
    const cached = await run([redactBeforeModel(), mw()]);
    expect(cached.res.messages).toEqual(plain.res.messages);
    expect(cached.res.counts).toEqual(plain.res.counts);
    expect(cached.res.status).toBe('completed');
    expect(cached.r.calls).toEqual(plain.r.calls);
    expect(cached.s.requests).toHaveLength(plain.s.requests.length);
    cached.s.requests.forEach((req, i) => {
      expect(req.messages.slice(2)).toEqual(plain.s.requests[i]!.messages);
    });
  });
});

describe('019f cache accounting: counts only, from the provider usage the model client returns', () => {
  const audited = async (usage: unknown, wrap = true) => {
    const pc = mw();
    const rows: AgentRunAuditRow[] = [];
    const s = scriptedModel(1, usage);
    const model = wrap ? pc.wrapModel(s.model) : s.model;
    await runAgent(
      deps(model, fakeRouter().router),
      [
        redactBeforeModel(),
        pc,
        auditAfterAgent(
          pc.auditSink(async (r) => {
            rows.push(r);
          })
        ),
      ],
      input('r8', 'u1', 'ws-alpha', 'Ahmed')
    );
    expect(rows).toHaveLength(1);
    return { row: rows[0]!, pc };
  };
  it("sums cacheReadTokens / cacheWriteTokens over the run's model calls into the agent_run row detail", async () => {
    const { row, pc } = await audited({
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
      inputTokens: 999,
    });
    expect(row.detail).toEqual({
      rounds: 2,
      toolsProposed: 1,
      toolsAllowed: 1,
      toolsRefused: 0,
      toolsPending: 0,
      cache_read_tokens: 200,
      cache_write_tokens: 40,
    });
    expect(JSON.stringify(row)).not.toMatch(/Ahmed|overdraft|Taamul/);
    expect(pc.takeCacheUsage('r8')).toBeUndefined();
  });
  it('malformed or missing usage counts as zero', async () => {
    expect(
      (await audited({ cacheReadTokens: -5, cacheWriteTokens: '7' })).row.detail
    ).toMatchObject({ cache_read_tokens: 0, cache_write_tokens: 0 });
    expect((await audited(undefined)).row.detail).toMatchObject({
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    expect(
      (await audited({ cacheReadTokens: 5 }, false)).row.detail
    ).toMatchObject({ cache_read_tokens: 0, cache_write_tokens: 0 });
  });
  it("takeCacheUsage returns and clears a run's counts", async () => {
    const pc = mw();
    const s = scriptedModel(0, { cacheReadTokens: 3, cacheWriteTokens: 4 });
    await runAgent(
      deps(pc.wrapModel(s.model), fakeRouter().router),
      [pc],
      input('r9', 'u1', 'ws-alpha', 'Ahmed')
    );
    expect(pc.takeCacheUsage('r9')).toEqual({
      cache_read_tokens: 3,
      cache_write_tokens: 4,
    });
    expect(pc.takeCacheUsage('r9')).toBeUndefined();
  });
});
