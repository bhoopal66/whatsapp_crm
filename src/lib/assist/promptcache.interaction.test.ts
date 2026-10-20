import { describe, it, expect } from 'vitest';
import {
  runAgent,
  AgentMiddlewareError,
  type AgentDeps,
  type AgentInput,
  type AgentMessage,
  type AgentMiddleware,
  type AgentState,
  type ModelRequest,
  type ModelResponse,
} from './middleware';
import { redactBeforeModel } from './middleware.builtin';
import type { ModelToolRouter } from './router';
import { redact } from '@/lib/memory/redact';
import {
  promptCacheMiddleware,
  type CachedMessage,
  type PromptToolDefinition,
} from './promptcache';

// 019e terminal redaction (runs after every wrap layer, immediately before deps.model) x 019f tier layout.
const CONSTANTS: Record<string, string> = {
  'sys.core':
    'You are the Taamul CRM assistant. Answer briefly and use the tools when you need data.',
  'ws.loans': 'Escalate any loan question to a human advisor.',
};
const TOOLS: PromptToolDefinition[] = [
  {
    name: 'get_contact',
    description: 'Read one contact',
    inputSchema: { type: 'object' },
  },
];
const EMAIL = 'ahmed.k@example.com';
const pc = () =>
  promptCacheMiddleware({
    constants: CONSTANTS,
    staticIds: ['sys.core'],
    tools: TOOLS,
    workspacePolicy: (ws) => (ws === 'ws-alpha' ? ['ws.loans'] : []),
  });
/** Injects personal data into a volatile message from a wrap layer, after every beforeModel redaction has run. */
const injector: AgentMiddleware = {
  name: 'injector',
  wrapModelCall: (state, next) => {
    state.messages = [
      ...state.messages,
      { role: 'user', content: `reach me at ${EMAIL}` },
    ];
    return next();
  },
};
const isBp = (m: AgentMessage) =>
  (m as Partial<CachedMessage>).cacheControl !== undefined;
const router: ModelToolRouter = {
  execute: async () => ({ status: 'ok', result: 'done' }),
};
function model() {
  const requests: ModelRequest[] = [];
  let i = 0;
  const call = async (req: ModelRequest): Promise<ModelResponse> => {
    requests.push(req);
    return ++i === 1
      ? { text: 't', toolCalls: [{ id: 'c1', tool: 'get_contact', args: {} }] }
      : { text: 'final', toolCalls: [] };
  };
  return { call, requests };
}
const input = (
  runId: string,
  workspaceId: string,
  who: string
): AgentInput => ({
  runId,
  userId: `u-${who}`,
  workspaceId,
  channel: 'whatsapp',
  messages: [{ role: 'user', content: `Hi, this is ${who}.` }],
});
const deps = (m: AgentDeps['model']): AgentDeps => ({ model: m, router });

describe('019f x 019e: terminal redaction and the tier layout', () => {
  for (const order of ['redactor first', 'promptCache first'] as const) {
    it(`${order}: static bytes identical, breakpoints only on the leading tiers, volatile PII redacted before the model`, async () => {
      const cache = pc();
      const list = (): AgentMiddleware[] =>
        order === 'redactor first'
          ? [redactBeforeModel(), cache, injector]
          : [cache, injector, redactBeforeModel()];
      const a = model();
      const b = model();
      await runAgent(deps(a.call), list(), input('ra', 'ws-alpha', 'Ahmed'));
      await runAgent(deps(b.call), list(), input('rb', 'ws-beta', 'Fatima'));
      const reqs = [...a.requests, ...b.requests];
      expect(reqs).toHaveLength(4);
      const statics = new Set<string>();
      for (const r of reqs) {
        const s = r.messages[0] as CachedMessage;
        expect(s.promptTier).toBe('static');
        expect(s.cacheControl).toEqual({ type: 'ephemeral' });
        expect(s.tools).toEqual([
          {
            name: 'get_contact',
            description: 'Read one contact',
            inputSchema: { type: 'object' },
          },
        ]);
        statics.add(JSON.stringify([s.role, s.content, s.cacheKey, s.tools]));
        const flags = r.messages.map(isBp);
        const k = flags.indexOf(false);
        expect(k).toBeGreaterThan(0);
        expect(flags.slice(k).some(Boolean)).toBe(false);
        expect(JSON.stringify(r.messages)).not.toContain(EMAIL);
        expect(
          r.messages.some(
            (m) =>
              m.role === 'user' &&
              m.content.startsWith('reach me at') &&
              m.content !== `reach me at ${EMAIL}`
          )
        ).toBe(true);
      }
      expect(statics.size).toBe(1);
      expect(
        a.requests.every((r) => r.messages.filter(isBp).length === 2)
      ).toBe(true);
      expect(
        b.requests.every((r) => r.messages.filter(isBp).length === 1)
      ).toBe(true);
    });
  }

  it('a terminal redactor that would change a cacheable tier aborts the run before the model (fail closed)', async () => {
    const m = model();
    const rewriting = (t: string) => redact(t.replace('Taamul', '[x]'));
    const err = await runAgent(
      deps(m.call),
      [pc(), redactBeforeModel(rewriting)],
      input('rc', 'ws-alpha', 'Ahmed')
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentMiddlewareError);
    expect((err as AgentMiddlewareError).hook).toBe('terminalRedact');
    expect(m.requests).toHaveLength(0);
  });

  it('cache fields survive only on the leading tier run: a forged tier message after a volatile one loses them', async () => {
    const m = model();
    const forger: AgentMiddleware = {
      name: 'forger',
      wrapModelCall: (state, next) => {
        state.messages = [
          ...state.messages,
          {
            role: 'system',
            content: 'late',
            promptTier: 'static',
            cacheControl: { type: 'ephemeral' },
            cacheKey: 'k',
          } as AgentMessage,
        ];
        return next();
      },
    };
    await runAgent(
      deps(m.call),
      [pc(), forger],
      input('rd', 'ws-beta', 'Ahmed')
    );
    for (const r of m.requests)
      expect(r.messages.map(isBp)).toEqual(r.messages.map((_, i) => i === 0));
  });

  it('a wrap layer before promptCache adds PII: the model sees it redacted and neither state nor the result keeps it or any tier message', async () => {
    const CARD = '4111 1111 1111 1111';
    const adder: AgentMiddleware = {
      name: 'adder',
      wrapModelCall: (state, next) => {
        state.messages = [
          ...state.messages,
          { role: 'user', content: `card ${CARD} mail ${EMAIL}` },
        ];
        return next();
      },
    };
    let seen: AgentState | undefined;
    const spy: AgentMiddleware = {
      name: 'spy',
      afterModel: (state) => {
        seen = state;
      },
    };
    const m = model();
    const res = await runAgent(
      deps(m.call),
      [adder, pc(), redactBeforeModel(), spy],
      input('re', 'ws-alpha', 'Ahmed')
    );
    expect(m.requests.length).toBeGreaterThan(0);
    const first = m.requests[0]!;
    expect(JSON.stringify(first.messages)).not.toContain(EMAIL);
    expect(JSON.stringify(first.messages)).not.toContain('4111');
    expect(
      first.messages.some(
        (x) => x.role === 'user' && x.content.startsWith('card ')
      )
    ).toBe(true);
    for (const out of [res.messages, seen?.messages ?? []]) {
      const j = JSON.stringify(out);
      expect(j).not.toContain(EMAIL);
      expect(j).not.toContain('4111');
      expect(j).not.toMatch(/promptTier|cacheControl|cacheKey|"tools"/);
      expect(out.some((x) => x.role === 'system')).toBe(false);
    }
  });

  it("no redactor registered: the run's state and result hold exactly the volatile messages", async () => {
    let seen: AgentState | undefined;
    const spy: AgentMiddleware = {
      name: 'spy',
      afterModel: (state) => {
        seen = state;
      },
    };
    const m = model();
    const res = await runAgent(
      deps(m.call),
      [pc(), spy],
      input('rf', 'ws-alpha', 'Ahmed')
    );
    expect(m.requests[0]!.messages.filter(isBp)).toHaveLength(2);
    expect(res.messages[0]).toEqual({
      role: 'user',
      content: 'Hi, this is Ahmed.',
    });
    expect(res.messages.some((x) => isBp(x) || x.role === 'system')).toBe(
      false
    );
    expect(seen?.messages[0]).toEqual({
      role: 'user',
      content: 'Hi, this is Ahmed.',
    });
  });
});
