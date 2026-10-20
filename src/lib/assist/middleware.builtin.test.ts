import { describe, it, expect } from 'vitest';
import {
  runAgent,
  AgentMiddlewareError,
  type AgentInput,
  type AgentMessage,
  type ModelRequest,
  type ModelResponse,
} from './middleware';
import {
  redactBeforeModel,
  contextBudget,
  auditAfterAgent,
  SUMMARY_PREFIX,
  type AgentRunAuditRow,
} from './middleware.builtin';
import type { ModelToolRouter } from './router';

const router: ModelToolRouter = {
  execute: async () => ({ status: 'ok', result: 'done' }),
};
const sent: ModelRequest[] = [];
const model = async (req: ModelRequest): Promise<ModelResponse> => {
  sent.push(req);
  return { text: 'answer', toolCalls: [] };
};
const base = {
  runId: 'r1',
  userId: 'u1',
  workspaceId: 'ws1',
  channel: 'whatsapp',
};
const run = (messages: AgentMessage[], mws: Parameters<typeof runAgent>[1]) => {
  sent.length = 0;
  return runAgent({ model, router, clock: { now: () => 0 } }, mws, {
    ...base,
    messages,
  } satisfies AgentInput);
};
const lastSent = () => sent[sent.length - 1]!.messages;

describe('019e redactBeforeModel', () => {
  it('redacts every message before the model sees it', async () => {
    await run(
      [
        { role: 'system', content: 's' },
        {
          role: 'user',
          content: 'mail me at a.b@example.com card 4111 1111 1111 1111',
        },
      ],
      [redactBeforeModel()]
    );
    const text = lastSent()
      .map((m) => m.content)
      .join('\n');
    expect(text).toContain('[EMAIL]');
    expect(text).toContain('[CARD]');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('4111');
  });
  it('redacts text a later beforeModel hook adds (wrapModelCall pass)', async () => {
    const adder = {
      name: 'adder',
      beforeModel: (s: { messages: AgentMessage[] }) => {
        s.messages = [...s.messages, { role: 'user', content: 'x@y.com' }];
      },
    };
    await run([{ role: 'user', content: 'hi' }], [redactBeforeModel(), adder]);
    expect(lastSent().map((m) => m.content)).not.toContain('x@y.com');
  });
  it('fails closed when the redactor throws or refuses: the model is never called', async () => {
    for (const redactor of [
      () => {
        throw new Error('boom');
      },
      () => ({ ok: false as const, refused: true as const, reason: 'x' }),
    ]) {
      const err = await run(
        [{ role: 'user', content: 'hi' }],
        [redactBeforeModel(redactor)]
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentMiddlewareError);
      expect(err).toMatchObject({ middleware: 'redactBeforeModel' });
      expect(sent).toHaveLength(0);
    }
  });
});

describe('019e contextBudget', () => {
  const long = (n: number, c = 'a') => c.repeat(n);
  const history = (): AgentMessage[] => [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'old1 ' + long(400) },
    { role: 'assistant', content: 'old2 ' + long(400) },
    { role: 'user', content: 'mid ' + long(400) },
    { role: 'assistant', content: 'mid2 ' + long(400) },
    { role: 'user', content: 'last1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'last2' },
  ];
  const opts = {
    maxTokens: 200,
    maxMessageChars: 2000,
    keepLastTurns: 2,
    offload: () => 'unused',
  };

  it('leaves a history within budget untouched', async () => {
    await run(
      [{ role: 'user', content: 'hi' }],
      [contextBudget({ ...opts, summarise: () => 'S' })]
    );
    expect(lastSent().map((m) => m.content)).toEqual(['hi']);
  });
  it('replaces older messages by the summary, keeping the system message and the last N turns', async () => {
    let got: readonly AgentMessage[] = [];
    await run(history(), [
      contextBudget({
        ...opts,
        summarise: (older) => {
          got = older;
          return 'SUMMARY';
        },
      }),
    ]);
    expect(got.map((m) => m.content.slice(0, 4))).toEqual([
      'old1',
      'old2',
      'mid ',
      'mid2',
    ]);
    expect(lastSent().map((m) => m.content)).toEqual([
      'SYS',
      SUMMARY_PREFIX + 'SUMMARY',
      'last1',
      'a1',
      'last2',
    ]);
  });
  it('falls back to truncating the oldest when the summariser throws, never the full history', async () => {
    await run(history(), [
      contextBudget({
        ...opts,
        maxTokens: 150,
        summarise: () => {
          throw new Error('down');
        },
      }),
    ]);
    const contents = lastSent().map((m) => m.content.slice(0, 5));
    expect(contents).toEqual(['SYS', 'mid2 ', 'last1', 'a1', 'last2']);
    expect(
      lastSent().reduce((n, m) => n + Math.ceil(m.content.length / 4) + 4, 0)
    ).toBeLessThanOrEqual(150);
  });
  it('an unusable summary (empty or over the size cap) also truncates', async () => {
    for (const s of ['', long(3000)]) {
      await run(history(), [contextBudget({ ...opts, summarise: () => s })]);
      expect(lastSent()[0]!.content).toBe('SYS');
      expect(lastSent().some((m) => m.content.startsWith('old1'))).toBe(false);
      expect(
        lastSent()
          .slice(-3)
          .map((m) => m.content)
      ).toEqual(['last1', 'a1', 'last2']);
    }
  });
  it('offloads a message over the size cap to a doc reference and never inlines it', async () => {
    const offloaded: AgentMessage[] = [];
    const big = 'BIG' + long(5000, 'z');
    await run(
      [{ role: 'user', content: big }],
      [
        contextBudget({
          ...opts,
          maxTokens: 100000,
          summarise: () => 'S',
          offload: (m) => {
            offloaded.push(m);
            return 'doc-42';
          },
        }),
      ]
    );
    expect(offloaded.map((m) => m.content)).toEqual([big]);
    expect(lastSent().map((m) => m.content)).toEqual(['[doc:doc-42]']);
  });
  it('fails closed when offload throws or returns an invalid id', async () => {
    for (const offload of [
      () => {
        throw new Error('store down');
      },
      () => 'bad id]',
    ]) {
      const err = await run(
        [{ role: 'user', content: long(5000) }],
        [contextBudget({ ...opts, summarise: () => 'S', offload })]
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({
        hook: 'beforeModel',
        middleware: 'contextBudget',
      });
      expect(sent).toHaveLength(0);
    }
  });
  it('rejects invalid options', () => {
    expect(() =>
      contextBudget({ ...opts, maxTokens: 0, summarise: () => '' })
    ).toThrow(RangeError);
    expect(() =>
      contextBudget({ ...opts, keepLastTurns: 0, summarise: () => '' })
    ).toThrow(RangeError);
  });
});

describe('019e auditAfterAgent', () => {
  it('appends one agent_run row with counts only', async () => {
    const rows: AgentRunAuditRow[] = [];
    const res = await run(
      [{ role: 'user', content: 'secret text a.b@example.com' }],
      [
        auditAfterAgent(async (r) => {
          rows.push(r);
        }),
      ]
    );
    expect(res.status).toBe('completed');
    expect(rows).toEqual([
      {
        kind: 'agent_run',
        runId: 'r1',
        userId: 'u1',
        workspaceId: 'ws1',
        channel: 'whatsapp',
        outcome: 'completed',
        detail: {
          rounds: 1,
          toolsProposed: 0,
          toolsAllowed: 0,
          toolsRefused: 0,
          toolsPending: 0,
        },
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/secret|example|answer/);
  });
  it('withholds the result when the append fails', async () => {
    const err = await run(
      [{ role: 'user', content: 'hi' }],
      [
        auditAfterAgent(async () => {
          throw new Error('db down');
        }),
      ]
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentMiddlewareError);
    expect(err).toMatchObject({
      hook: 'afterAgent',
      middleware: 'auditAfterAgent',
    });
  });
});
