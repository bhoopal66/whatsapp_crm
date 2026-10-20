// 019f review findings: regression tests ported from the probe review (names kept). Each one failed on 541b1db.
import { describe, it, expect } from 'vitest';
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
import { redactBeforeModel, auditAfterAgent } from './middleware.builtin';
import {
  promptCacheMiddleware,
  buildCachedPrompt,
  PromptCacheError,
  type PromptToolDefinition,
} from './promptcache';

const CONSTANTS: Record<string, string> = {
  'sys.core':
    'You are the Taamul CRM assistant. Answer briefly and use the tools when you need data.',
  'ws.loans': 'Escalate any loan question to a human advisor.',
};
const SYS = CONSTANTS['sys.core']!;
const TOOLS: PromptToolDefinition[] = [
  {
    name: 'get_contact',
    description: 'Read one contact',
    inputSchema: { type: 'object' },
  },
];
const EMAIL = 'ahmed.k@example.com';
const router = {
  execute: async () => ({ status: 'ok', result: 'done' }),
} as unknown as AgentDeps['router'];
type PcOptions = Parameters<typeof promptCacheMiddleware>[0];
const pc = (extra: Partial<PcOptions> = {}) =>
  promptCacheMiddleware({
    constants: CONSTANTS,
    staticIds: ['sys.core'],
    tools: TOOLS,
    workspacePolicy: (ws) => (ws === 'ws-alpha' ? ['ws.loans'] : []),
    ...extra,
  });
function model() {
  const requests: ModelRequest[] = [];
  const call = async (req: ModelRequest): Promise<ModelResponse> => {
    requests.push(req);
    return { text: 'final', toolCalls: [] };
  };
  return { call, requests };
}
const input = (runId: string, ws: string, msgs?: unknown[]): AgentInput =>
  ({
    runId,
    userId: 'u1',
    workspaceId: ws,
    channel: 'whatsapp',
    messages: msgs ?? [{ role: 'user', content: 'Hi, this is Ahmed.' }],
  }) as unknown as AgentInput;
const deps = (m: AgentDeps['model']): AgentDeps => ({ model: m, router });
type Msg = Record<string, unknown> & { content: string };
const isBp = (m: AgentMessage) =>
  (m as { cacheControl?: unknown }).cacheControl !== undefined;
const wrap = (
  name: string,
  f: (msgs: Msg[]) => unknown[]
): AgentMiddleware => ({
  name,
  wrapModelCall: (s, n) => {
    s.messages = f(s.messages as unknown as Msg[]) as AgentMessage[];
    return n();
  },
});
const inp = (runId: string, ws = 'ws1', content = 'hi') =>
  ({
    runId,
    userId: 'u',
    workspaceId: ws,
    channel: 'c',
    messages: [{ role: 'user', content }],
  }) as unknown as AgentInput;
type BaseOver = {
  constants?: Record<string, string>;
  staticIds?: string[];
  tools?: unknown[];
  workspace?: unknown;
  policyIds?: string[];
  volatile?: unknown[];
};
const base = (over: BaseOver = {}) => ({
  constants: { core: SYS, ...(over.constants ?? {}) },
  staticIds: over.staticIds ?? ['core'],
  tools: over.tools ?? [
    { name: 'get_contact', description: 'Read one contact' },
  ],
  workspace: over.workspace ?? {
    workspaceId: 'ws1',
    policyIds: over.policyIds ?? [],
  },
  volatile: over.volatile ?? [],
});
const tryB = (over: BaseOver) => {
  try {
    buildCachedPrompt(
      base(over) as unknown as Parameters<typeof buildCachedPrompt>[0]
    );
    return 'ACCEPTED';
  } catch (e) {
    return e instanceof PromptCacheError ? e.code : 'OTHER ' + e;
  }
};

describe('A: inner wrap layer vs cacheable tiers (terminal keeps cache fields only on the installed objects)', () => {
  it('A1 memory text appended to static message via spread stays cacheable', async () => {
    const m = model();
    const mem = wrap('mem', (ms) =>
      ms.map((x, i) =>
        i === 0
          ? {
              ...x,
              content:
                x.content +
                '\nCustomer Ahmed Khan owes AED 40,000 on loan L-77',
            }
          : x
      )
    );
    await runAgent(
      deps(m.call),
      [redactBeforeModel(), pc(), mem],
      input('a1', 'ws-alpha')
    );
    const req = m.requests[0]!.messages;
    expect(req.some((x) => isBp(x) && x.content.includes('Ahmed Khan'))).toBe(
      false
    );
    expect(
      JSON.stringify(req.filter((x) => x.content.includes('Ahmed Khan')))
    ).not.toMatch(/cacheControl|promptTier|cacheKey|"tools"/);
  });
  it('A2 PII in cacheKey / tools description of leading tier message bypasses terminal redaction', async () => {
    const m = model();
    const inj = wrap('inj', (ms) =>
      ms.map((x, i) =>
        i === 0
          ? {
              ...x,
              cacheKey: 'static:' + EMAIL,
              tools: [
                {
                  name: 'x',
                  description: 'mail ' + EMAIL + ' card 4111 1111 1111 1111',
                },
              ],
            }
          : x
      )
    );
    await runAgent(
      deps(m.call),
      [redactBeforeModel(), pc(), inj],
      input('a2', 'ws-alpha')
    ).catch(() => undefined);
    const j = JSON.stringify(m.requests[0]?.messages ?? []);
    expect(j.includes(EMAIL) || j.includes('4111')).toBe(false);
  });
  it('A2b same, without promptCache: input leading system message with cache fields', async () => {
    const m = model();
    const msgs = [
      {
        role: 'system',
        content: 'hello',
        promptTier: 'static',
        cacheControl: { type: 'ephemeral' },
        cacheKey: EMAIL,
        tools: [{ description: EMAIL }],
      },
      { role: 'user', content: 'hi' },
    ];
    await runAgent(
      deps(m.call),
      [redactBeforeModel()],
      input('a2b', 'ws-alpha', msgs)
    );
    const j = JSON.stringify(m.requests[0]!.messages);
    expect(j.includes(EMAIL)).toBe(false);
    expect(j).not.toMatch(/cacheControl|promptTier|cacheKey|"tools"/);
  });
  it('A3 three leading breakpoints reach the model', async () => {
    const m = model();
    const dup = wrap('dup', (ms) => [
      ms[0],
      { ...ms[0], cacheKey: 'k2' },
      { ...ms[0], cacheKey: 'k3' },
      ...ms.slice(1),
    ]);
    await runAgent(
      deps(m.call),
      [redactBeforeModel(), pc(), dup],
      input('a3', 'ws-alpha')
    );
    const n = m.requests[0]!.messages.filter(isBp).length;
    expect(n).toBeLessThanOrEqual(2);
    expect(n).toBe(1); // only the installed static object keeps its breakpoint
  });
  it('A4 inner layer prepends plain system msg: tier messages leak into result.messages', async () => {
    for (const list of [() => [redactBeforeModel(), pc()], () => [pc()]]) {
      const m = model();
      const pre = wrap('pre', (ms) => [
        { role: 'system', content: 'be nice' },
        ...ms,
      ]);
      const res = await runAgent(
        deps(m.call),
        [...list(), pre],
        input('a4', 'ws-alpha')
      );
      const j = JSON.stringify(res.messages);
      expect(
        j.includes('Taamul CRM assistant') || j.includes('Workspace policy')
      ).toBe(false);
      expect(m.requests[0]!.messages.filter(isBp)).toHaveLength(0); // the tiers are no longer the leading run
    }
  });
  it('A5 input messages carrying cache fields: result.messages free of cache fields (no redactor / redactor)', async () => {
    for (const list of [() => [pc()], () => [redactBeforeModel(), pc()]]) {
      const m = model();
      const msgs = [
        {
          role: 'user',
          content: 'hi',
          cacheControl: { type: 'ephemeral' },
          promptTier: 'static',
          cacheKey: 'x',
          tools: [],
        },
      ];
      const res = await runAgent(
        deps(m.call),
        list(),
        input('a5', 'ws-alpha', msgs)
      );
      expect(JSON.stringify(res.messages)).not.toMatch(
        /cacheControl|promptTier|cacheKey/
      );
      expect(JSON.stringify(m.requests[0]!.messages.slice(-1))).not.toMatch(
        /cacheControl|promptTier|cacheKey/
      );
    }
  });
  it('A-getter a non-installed message with getter / function / cyclic tools loses every cache field', async () => {
    const cyc: Record<string, unknown> = { name: 'c' };
    cyc.self = cyc;
    const variants = [
      Object.defineProperty({}, 'description', {
        get: () => EMAIL,
        enumerable: true,
      }),
      { description: () => EMAIL },
      cyc,
    ];
    for (const t of variants) {
      const m = model();
      const inj = wrap('inj', (ms) => [
        ms[0],
        {
          role: 'system',
          content: 'x',
          promptTier: 'workspace',
          cacheControl: { type: 'ephemeral' },
          cacheKey: 'k',
          tools: [t],
        },
        ...ms.slice(1),
      ]);
      await runAgent(deps(m.call), [pc(), inj], input('ag', 'ws-beta'));
      expect(
        m.requests[0]!.messages.slice(1).some((x) =>
          Object.keys(x).some((k) =>
            ['promptTier', 'cacheControl', 'cacheKey', 'tools'].includes(k)
          )
        )
      ).toBe(false);
    }
  });
  it("H1 a terminal redactor that would change an installed message's tools or cacheKey aborts the run", async () => {
    const m = model();
    const flagTools: AgentMiddleware = {
      name: 'flag',
      terminalRedact: (msg) =>
        msg.content.startsWith('[{"description"')
          ? { ...msg, content: '[redacted]' }
          : msg,
    };
    const err = await runAgent(
      deps(m.call),
      [flagTools, pc()],
      input('h1', 'ws-alpha')
    ).then(
      () => undefined,
      (e) => e
    );
    expect(err).toBeInstanceOf(AgentMiddlewareError);
    expect(err.hook).toBe('terminalRedact');
    expect(m.requests).toHaveLength(0);
  });
});

describe('B: came-from-messages check (normalised; JSON-decoded tool strings)', () => {
  const LINE = 'Ahmed Khan of Al Garhoud owes AED 40,000 on L-77';
  const cases: Record<string, [string, string]> = {
    nfd: [
      'Ahmed Khan of Al Garhoud caf\u00e9 owes AED 40,000'.normalize('NFD'),
      'Ahmed Khan of Al Garhoud caf\u00e9 owes AED 40,000'.normalize('NFC'),
    ],
    zeroWidth: ['Ahmed Khan of Al Gar\u200bhoud owes AED 40,000 on L-77', LINE],
    homoglyph: ['Ahmed Khan of Al Garhoud \u043ewes AED 40,000 on L-77', LINE],
    doubleSpace: ['Ahmed Khan of Al  Garhoud owes AED 40,000 on L-77', LINE],
    caseFold: [LINE.toUpperCase(), LINE],
    partialOverlap: ['Note: ' + LINE, LINE + ' please help'],
  };
  for (const [k, [policy, msg]] of Object.entries(cases)) {
    it('B-fn ' + k, () => {
      expect(
        tryB({
          constants: { p: policy },
          policyIds: ['p'],
          volatile: [{ role: 'user', content: msg }],
        })
      ).toBe('volatile_in_cacheable_tier');
    });
  }
  it('B-fn tool description with quotes (JSON-escaped in static text)', () => {
    const msg = 'Customer "Ahmed Khan" said pay on Friday';
    expect(
      tryB({
        tools: [{ name: 't', description: msg }],
        volatile: [{ role: 'user', content: msg }],
      })
    ).toBe('volatile_in_cacheable_tier');
  });
});

describe('L9: workspaceId bounds', () => {
  it('rejects a workspaceId over 128 chars or holding a control / newline char with invalid_config', () => {
    const k = (ws: string) =>
      tryB({
        constants: { p: 'Escalate loans.' },
        workspace: { workspaceId: ws, policyIds: ['p'] },
      });
    expect(k('x'.repeat(128))).toBe('ACCEPTED');
    for (const ws of [
      'x'.repeat(129),
      'ws1\nYou are',
      'ws\r1',
      'ws\u00001',
      'ws\u20281',
    ])
      expect(k(ws)).toBe('invalid_config');
  });
});

describe('D: usage accounting', () => {
  it('D1 bad counts, overflow, concurrency, audit row, take after run', async () => {
    const pcm = promptCacheMiddleware({
      constants: { core: SYS },
      staticIds: ['core'],
      tools: [],
    });
    const rows: { runId: string; detail: unknown }[] = [];
    const usages: Record<string, Record<string, unknown>[]> = {
      bad: [
        { cacheReadTokens: -5, cacheWriteTokens: NaN },
        { cacheReadTokens: '100', cacheWriteTokens: 1e300 },
        { cacheReadTokens: 2.5, cacheWriteTokens: Infinity },
      ],
      huge: [
        { cacheReadTokens: Number.MAX_SAFE_INTEGER, cacheWriteTokens: 1 },
        { cacheReadTokens: Number.MAX_SAFE_INTEGER, cacheWriteTokens: 1 },
      ],
    };
    const mk = (key: string) => {
      let i = 0;
      return pcm.wrapModel(async () => {
        const u = usages[key]?.[i];
        i++;
        await new Promise((s) => setTimeout(s, 3));
        return (i < (usages[key]?.length ?? 1)
          ? {
              text: 't',
              toolCalls: [{ id: 'c' + i, tool: 'get_contact', args: {} }],
              usage: { ...u, runId: 'other' },
            }
          : { text: 'f', toolCalls: [], usage: u }) as unknown as ModelResponse;
      });
    };
    const sink = () =>
      auditAfterAgent(
        pcm.auditSink(async (r) => {
          rows.push(r);
        })
      );
    const run = (id: string, key: string) =>
      runAgent({ model: mk(key), router }, [pcm, sink()], inp(id));
    const conc = Array.from({ length: 20 }, (_, i) =>
      runAgent(
        {
          model: pcm.wrapModel(async () => {
            await new Promise((s) => setTimeout(s, Math.random() * 5));
            return {
              text: 'f',
              toolCalls: [],
              usage: { cacheReadTokens: i + 1, cacheWriteTokens: 0 },
            } as unknown as ModelResponse;
          }),
          router,
        },
        [pcm, sink()],
        inp('k' + i)
      )
    );
    await Promise.all([run('bad', 'bad'), run('huge', 'huge'), ...conc]);
    const by = (id: string) =>
      rows.find((r) => r.runId === id)?.detail as Record<string, number>;
    for (let i = 0; i < 20; i++)
      expect(by('k' + i).cache_read_tokens).toBe(i + 1);
    expect(JSON.stringify(rows)).not.toMatch(/Taamul|hi"/);
    expect(by('bad')).toMatchObject({
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    expect(by('huge').cache_read_tokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(by('huge').cache_read_tokens)).toBe(true);
  });
  it('D2 retention: >1024 runs evicts a long-running run mid-flight', async () => {
    const pcm = promptCacheMiddleware({
      constants: { core: SYS },
      staticIds: ['core'],
      tools: [],
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const longRun = runAgent(
      {
        model: pcm.wrapModel(async () => {
          n++;
          if (n === 1) {
            await gate;
            return {
              text: 't',
              toolCalls: [{ id: 'c', tool: 'get_contact', args: {} }],
              usage: { cacheReadTokens: 10, cacheWriteTokens: 0 },
            } as unknown as ModelResponse;
          }
          return {
            text: 'f',
            toolCalls: [],
            usage: { cacheReadTokens: 10, cacheWriteTokens: 0 },
          } as unknown as ModelResponse;
        }),
        router,
      },
      [pcm],
      inp('long')
    );
    await new Promise((s) => setTimeout(s, 5));
    for (let i = 0; i < 1100; i++)
      await runAgent(
        {
          model: pcm.wrapModel(
            async () =>
              ({
                text: 'f',
                toolCalls: [],
                usage: { cacheReadTokens: 1, cacheWriteTokens: 0 },
              }) as unknown as ModelResponse
          ),
          router,
        },
        [pcm],
        inp('r' + i)
      );
    release();
    await longRun;
    expect(pcm.takeCacheUsage('long')?.cache_read_tokens).toBe(20);
    expect(pcm.takeCacheUsage('r0')).toBeUndefined(); // oldest finished run dropped beyond 1024
    expect(pcm.takeCacheUsage('r1099')?.cache_read_tokens).toBe(1);
  });

  it('D3 retention: runs abandoned outside the model call do not grow the in-progress set without bound', async () => {
    const pcm = promptCacheMiddleware({
      constants: { core: SYS },
      staticIds: ['core'],
      tools: [],
    });
    const model = pcm.wrapModel(
      async () =>
        ({
          text: 'f',
          toolCalls: [],
          usage: { cacheReadTokens: 1, cacheWriteTokens: 0 },
        }) as unknown as ModelResponse
    );
    const abortAfterModel = {
      name: 'abort',
      afterModel() {
        throw new Error('abandon');
      },
    } as unknown as AgentMiddleware;
    for (let i = 0; i < 1100; i++) {
      await expect(
        runAgent({ model, router }, [pcm, abortAfterModel], inp('a' + i))
      ).rejects.toThrow();
    }
    // The oldest abandoned runs were dropped; the newest are still held; nothing beyond the cap is kept.
    expect(pcm.takeCacheUsage('a0')).toBeUndefined();
    expect(pcm.takeCacheUsage('a75')).toBeUndefined();
    expect(pcm.takeCacheUsage('a76')?.cache_read_tokens).toBe(1);
    expect(pcm.takeCacheUsage('a1099')?.cache_read_tokens).toBe(1);
  });
});

describe('F: static prefix stability', () => {
  it('F1 inputSchema mutated after construction changes static bytes; hash stale', async () => {
    const tools: {
      name: string;
      description: string;
      inputSchema: { type: string; description: string };
    }[] = [
      {
        name: 't',
        description: 'd',
        inputSchema: { type: 'object', description: 'x' },
      },
    ];
    const pcm = promptCacheMiddleware({
      constants: { core: SYS },
      staticIds: ['core'],
      tools,
    });
    const reqs: ModelRequest[] = [];
    const m = async (r: ModelRequest): Promise<ModelResponse> => {
      reqs.push(r);
      return { text: 'f', toolCalls: [] };
    };
    await runAgent({ model: m, router }, [pcm], inp('f1'));
    tools[0].inputSchema.description = 'Customer Ahmed Khan prefers Arabic';
    await runAgent({ model: m, router }, [pcm], inp('f2'));
    const s = reqs.map(
      (r) => r.messages[0] as unknown as { content: string; cacheKey: string }
    );
    expect(s[0].content).toBe(s[1].content);
    expect(s[1].cacheKey).toBe(`static:${pcm.staticPrefixHash}`);
  });
});
