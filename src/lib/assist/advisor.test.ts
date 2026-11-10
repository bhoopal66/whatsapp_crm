import { describe, expect, it } from 'vitest';
import type { TypeSafeGateway } from '@/lib/typesafe/client';
import {
  makeLayer,
  makeSim,
  TEST_ACCOUNT,
  testConfig,
} from '@/lib/typesafe/test-helpers';
import type { TokenVault } from '@/lib/vault/tokenize';
import { adviseTools, type AdvisorDeps, type AdvisorTool } from './advisor';
import { ToolRegistry } from './registry';

const PHONE = '+971 50 123 4567';
const EID = '784-1990-1234567-1';
const TEXT = `Please text the customer on ${PHONE}, EID ${EID}`;
const TOOLS: AdvisorTool[] = [
  {
    name: 'send_message',
    description: 'Sends a WhatsApp message to a customer.',
  },
  { name: 'add_note', description: 'Adds a staff note to a customer record.' },
  {
    name: 'delete_contact',
    description: 'Removes a customer record for good.',
  },
];
const registry = new ToolRegistry();

type Ask = TypeSafeGateway['ask'];
/** Fake gateway: records each request, answers per ordinal key. */
function fakeGateway(
  reply: (questions: Record<string, unknown>) => Awaited<ReturnType<Ask>>
) {
  const calls: { state: unknown; questions: Record<string, unknown> }[] = [];
  const gateway = {
    ask: (async (_check, state, questions) => {
      calls.push({ state, questions: questions as Record<string, unknown> });
      return reply(questions as Record<string, unknown>);
    }) as Ask,
  };
  return { gateway, calls };
}
const answered = (
  answers: Record<string, number>,
  modelMismatch = false
): Awaited<ReturnType<Ask>> =>
  ({
    ok: true,
    latencyMs: 1,
    modelMismatch,
    result: {
      answers: Object.fromEntries(
        Object.entries(answers).map(([k, p]) => [k, { type: 'noul', noul: p }])
      ),
    },
  }) as unknown as Awaited<ReturnType<Ask>>;

const deps = (
  gateway: AdvisorDeps['gateway'],
  over: Partial<AdvisorDeps> = {}
) =>
  ({ config: testConfig(), gateway, registry, ...over }) satisfies AdvisorDeps;

const digits = (s: string) => s.replace(/\D/g, '');

describe('adviseTools', () => {
  it('redacts the text before the request: no phone or Emirates ID reaches TypeSafe', async () => {
    const { gateway, calls } = fakeGateway(() =>
      answered({ t1: 0.9, t2: 0.1, t3: 0.1 })
    );
    const out = await adviseTools({
      accountId: TEST_ACCOUNT,
      text: TEXT,
      tools: TOOLS,
      deps: deps(gateway),
    });
    expect(out.status).toBe('ok');
    expect(calls).toHaveLength(1);
    const sent = JSON.stringify(calls[0]);
    expect(sent).toContain('Please text the customer');
    expect(sent).toContain('[PHONE]');
    expect(sent).toContain('[EID]');
    expect(digits(sent)).not.toContain(digits(PHONE).slice(3));
    expect(digits(sent)).not.toContain(digits(EID));
  });

  it('tokenises through the vault first when one is given', async () => {
    const puts: string[] = [];
    const store: TokenVault = {
      async put(_ws, kind, value) {
        puts.push(`${kind}:${value}`);
        return {
          token: `vlt_${'g'.repeat(25)}${'hjkm'[puts.length - 1]}`,
          deduped: false,
        };
      },
    };
    const vault = {
      store,
      context: {
        workspace: TEST_ACCOUNT,
        subject: { type: 'contact' as const, id: 'c1' },
        actor: 'u1',
      },
    };
    const { gateway, calls } = fakeGateway(() =>
      answered({ t1: 0.5, t2: 0.5, t3: 0.5 })
    );
    await adviseTools({
      accountId: TEST_ACCOUNT,
      text: TEXT,
      tools: TOOLS,
      deps: deps(gateway, { vault }),
    });
    expect(puts.length).toBeGreaterThan(0);
    const sent = JSON.stringify(calls[0]);
    expect(sent).toMatch(/\[(PHONE|EID):vlt_/);
    expect(digits(sent)).not.toContain(digits(EID));

    const failing = {
      ...vault,
      store: {
        put: async () => Promise.reject(new Error('db down')),
      } as TokenVault,
    };
    const f = fakeGateway(() => answered({}));
    const out = await adviseTools({
      accountId: TEST_ACCOUNT,
      text: TEXT,
      tools: TOOLS,
      deps: deps(f.gateway, { vault: failing }),
    });
    expect(out).toEqual({ status: 'unavailable', suggestions: [] });
    expect(f.calls).toHaveLength(0);
  });

  it('sends ordinal keys and descriptions only, and maps ordinals back to tool names', async () => {
    const { gateway, calls } = fakeGateway(() =>
      answered({ t1: 0.2, t2: 0.95, t3: 0.6 })
    );
    const out = await adviseTools({
      accountId: TEST_ACCOUNT,
      text: 'note that she called',
      tools: [...TOOLS, { name: 'not_registered', description: 'Something.' }],
      deps: deps(gateway),
    });
    expect(Object.keys(calls[0]!.questions)).toEqual(['t1', 't2', 't3']);
    const sent = JSON.stringify(calls[0]);
    for (const t of [...TOOLS.map((x) => x.name), 'not_registered'])
      expect(sent).not.toContain(t);
    expect(sent).toContain('Adds a staff note');
    expect(out).toEqual({
      status: 'ok',
      suggestions: [
        { toolName: 'add_note', score: 0.95 },
        { toolName: 'delete_contact', score: 0.6 },
        { toolName: 'send_message', score: 0.2 },
      ],
    });
  });

  it('works end to end through the real gateway and SDK against the simulator', async () => {
    const sim = makeSim(() => ({ answers: { t1: 0.1, t2: 0.8, t3: 0.05 } }));
    const { layer } = makeLayer({ sim });
    const out = await adviseTools({
      accountId: TEST_ACCOUNT,
      text: TEXT,
      tools: TOOLS,
      deps: deps(layer.gateway),
    });
    expect(out.suggestions[0]).toEqual({ toolName: 'add_note', score: 0.8 });
    expect(sim.calls).toHaveLength(1);
    expect(digits(sim.calls[0]!.raw)).not.toContain(digits(EID));
    expect(sim.calls[0]!.raw).not.toContain('send_message');
  });

  it('a model mismatch is unavailable, with no suggestions', async () => {
    const { gateway } = fakeGateway(() =>
      answered({ t1: 0.9, t2: 0.9, t3: 0.9 }, true)
    );
    const out = await adviseTools({
      accountId: TEST_ACCOUNT,
      text: 'hi',
      tools: TOOLS,
      deps: deps(gateway),
    });
    expect(out).toEqual({ status: 'unavailable', suggestions: [] });
  });

  it('a missing answer is unavailable: half a judgment is never used', async () => {
    const { gateway } = fakeGateway(() => answered({ t1: 0.9 }));
    const out = await adviseTools({
      accountId: TEST_ACCOUNT,
      text: 'hi',
      tools: TOOLS,
      deps: deps(gateway),
    });
    expect(out.status).toBe('unavailable');
  });

  it('a throwing client is unavailable and never throws', async () => {
    const gateway = {
      ask: (async () => {
        throw new Error('boom');
      }) as Ask,
    };
    await expect(
      adviseTools({
        accountId: TEST_ACCOUNT,
        text: 'hi',
        tools: TOOLS,
        deps: deps(gateway),
      })
    ).resolves.toEqual({ status: 'unavailable', suggestions: [] });
  });

  it('a gateway error is unavailable; no key or a disallowed account is off', async () => {
    const err = (errorCode: string) =>
      fakeGateway(
        () =>
          ({ ok: false, errorCode, latencyMs: 0, message: 'x' }) as Awaited<
            ReturnType<Ask>
          >
      );
    const run = (g: AdvisorDeps['gateway'], over: Partial<AdvisorDeps> = {}) =>
      adviseTools({
        accountId: TEST_ACCOUNT,
        text: 'hi',
        tools: TOOLS,
        deps: deps(g, over),
      });
    expect((await run(err('BREAKER_OPEN').gateway)).status).toBe('unavailable');
    expect((await run(err('DISABLED').gateway)).status).toBe('off');
    const f = fakeGateway(() => answered({}));
    expect(
      (
        await run(f.gateway, {
          config: testConfig({ accounts: ['someone-else'] }),
        })
      ).status
    ).toBe('off');
    expect(f.calls).toHaveLength(0);
  });

  it('an empty tool list (or only unregistered / undescribed tools) sends no request', async () => {
    const { gateway, calls } = fakeGateway(() => answered({}));
    for (const tools of [
      [],
      [{ name: 'nope', description: 'x' }],
      [{ name: 'add_note', description: '  ' }],
    ]) {
      const out = await adviseTools({
        accountId: TEST_ACCOUNT,
        text: 'hi',
        tools,
        deps: deps(gateway),
      });
      expect(out).toEqual({ status: 'ok', suggestions: [] });
    }
    expect(calls).toHaveLength(0);
  });

  it('caps suggestions at maxSuggestions', async () => {
    const { gateway } = fakeGateway(() =>
      answered({ t1: 0.3, t2: 0.2, t3: 0.1 })
    );
    const out = await adviseTools({
      accountId: TEST_ACCOUNT,
      text: 'hi',
      tools: TOOLS,
      deps: deps(gateway, { maxSuggestions: 1 }),
    });
    expect(out.suggestions).toEqual([{ toolName: 'send_message', score: 0.3 }]);
  });
});
