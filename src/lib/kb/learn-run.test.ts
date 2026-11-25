import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => ({}) }));
const loadAiConfig = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@/lib/ai/config', () => ({ loadAiConfig }));

import { AiError, type AiConfig } from '@/lib/ai/types';
import { buildNameMatcher } from './known-names';
import type { Skill } from './skills';
import {
  EVOLVE_INTERVAL_MS,
  EVOLVE_MIN_BUDGET_MS,
  defaultDeps,
  evolveSkills,
  learnAccount,
  learnTopic as learnTopicWith,
  supabaseKbLearnStore,
  topicKey,
  runKbLearning,
  TOPIC_MIN_BUDGET_MS,
  type KbLearnDeps,
  type KbLearnStore,
  type LearnGap,
  type LearnThread,
  type RecordDraftArgs,
  type ReviewRow,
} from './learn-run';
import type { ThreadMessage } from './learn';

const ACCOUNT = 'acct-1';
/** With the account's names (none but the chats' own unless given). */
const learnTopic = (
  d: KbLearnDeps,
  accountId: string,
  config: AiConfig,
  topic: Omit<Parameters<typeof learnTopicWith>[3], 'gapIds'> & {
    gapIds?: string[];
  },
  names: string[] = []
) =>
  learnTopicWith(
    d,
    accountId,
    config,
    { gapIds: ['g1', 'g2'], ...topic },
    names
  );
const GAP_AT = '2026-11-10T10:00:00.000Z';
const at = (minutes: number) =>
  new Date(Date.parse(GAP_AT) + minutes * 60_000).toISOString();

const CONFIG = {
  accountId: ACCOUNT,
  provider: 'openai',
  model: 'gpt-standard',
  modelSmall: 'gpt-small',
  apiKey: 'sk-test',
} as unknown as AiConfig;

// What a customer and an agent really typed: every identifier here must
// be masked before anything reaches the model.
const SECRETS = [
  'Fatima',
  'Rahman',
  'Yusuf',
  '+971 50 123 4567',
  'fatima.rahman@example.com',
  'AE070331234567890123456',
  '784-1987-1234567-1',
  '4111 1111 1111 1111',
  '0123456789012',
];

const reply = (text: string, minutes = 20): ThreadMessage => ({
  sender_type: 'agent',
  sender_id: 'agent-user',
  content_type: 'text',
  content_text: text,
  template_name: null,
  status: 'sent',
  created_at: at(minutes),
});

const gap = (id: string, conversation: string | null): LearnGap => ({
  id,
  conversation_id: conversation,
  question: `Hi I am Fatima Rahman, my number is +971 50 123 4567, can I open an account without a trade licence?`,
  created_at: GAP_AT,
});

function fakeStore(
  over: Partial<KbLearnStore> & {
    threads?: Record<string, LearnThread | null>;
  } = {}
): KbLearnStore & {
  recorded: RecordDraftArgs[];
  finished: [string, number, string | null][];
} {
  const recorded: RecordDraftArgs[] = [];
  const finished: [string, number, string | null][] = [];
  const threads: Record<string, LearnThread | null> = over.threads ?? {
    c1: {
      messages: [
        {
          ...reply('bot handoff'),
          sender_type: 'bot',
          sender_id: null,
          created_at: at(1),
        },
        reply(
          'Hello Fatima, yes you can with a freelance permit. Send it to fatima.rahman@example.com, IBAN AE070331234567890123456, EID 784-1987-1234567-1, card 4111 1111 1111 1111, account 0123456789012. Yusuf'
        ),
      ],
      contactName: 'Fatima Rahman',
      senderNames: { 'agent-user': 'Yusuf Ali' },
    },
    c2: {
      messages: [reply('Yes, a freelance permit works instead of a licence.')],
      contactName: 'Omar',
      senderNames: { 'agent-user': 'Yusuf Ali' },
    },
  };
  return {
    recorded,
    finished,
    dueAccounts: async () => [ACCOUNT],
    claimRun: async () => true,
    finishRun: async (id, n, error) => {
      finished.push([id, n, error]);
    },
    askedThisWeek: async () => 0,
    openTopics: async () => [
      {
        id: 't1',
        label: 'Account without a trade licence?',
        coverage: 'none',
        gapIds: ['g1', 'g2'],
      },
    ],
    topicDrafted: async () => false,
    gaps: async () => [gap('g1', 'c1'), gap('g2', 'c2')],
    thread: async (_a, conversationId) => threads[conversationId] ?? null,
    knownNames: async () => [],
    recordDiscard: async () => {},
    noteLook: async () => {},
    activeSkills: async () => [],
    skillTitles: async () => [],
    reviewRows: async () => [],
    markReviewed: async () => {},
    distillState: async () => ({ enabled: true, lastDistilledAt: null }),
    addSkills: async () => 0,
    recordDraft: async (args) => {
      recorded.push(args);
      return 'drafted';
    },
    ...over,
  };
}

function deps(
  store: KbLearnStore,
  over: Partial<KbLearnDeps> = {}
): KbLearnDeps & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    store,
    loadConfig: async () => CONFIG,
    generate: vi.fn(async (args) => {
      sent.push(args.systemPrompt);
      for (const m of args.messages) sent.push(m.content);
      return {
        text: '{"question":"Can I open an account without a trade licence?","answer_en":"Yes. A freelance permit can stand in for a trade licence."}',
        handoff: false,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    }),
    logUsage: vi.fn(async () => {}),
    now: () => 0,
    random: () => 0.5,
    ...over,
  };
}

describe('learnTopic', () => {
  it('never sends unredacted text to the model', async () => {
    const store = fakeStore();
    const d = deps(store);
    const out = await learnTopic(d, ACCOUNT, CONFIG, {
      id: 't1',
      label: 'Account without a trade licence? call +971 50 123 4567',
      coverage: 'none',
    });
    expect(out).toEqual({ drafted: true });
    const everything = d.sent.join('\n');
    expect(everything).toContain('freelance permit');
    for (const secret of SECRETS) expect(everything).not.toContain(secret);
    // No database ids either.
    for (const id of ['g1', 'g2', 'c1', 'c2', 't1', 'agent-user', ACCOUNT])
      expect(everything).not.toMatch(new RegExp(`\\b${id}\\b`));
  });

  it('drafts through the store as a learned draft with notes', async () => {
    const store = fakeStore();
    const d = deps(store);
    await learnTopic(d, ACCOUNT, CONFIG, {
      id: 't1',
      label: 'Account without a trade licence?',
      coverage: 'unknown',
    });
    expect(store.recorded).toHaveLength(1);
    const r = store.recorded[0]!;
    expect(r.ref).toMatch(/^LRN-[A-Z0-9]{8}$/);
    expect(r.question).toBe('Can I open an account without a trade licence?');
    // The ledger keeps a hash, never the label.
    expect(r.topicKey).toBe(
      topicKey(ACCOUNT, ' account WITHOUT a trade licence?')
    );
    expect(r.topicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(r.answerEn).toContain('freelance permit');
    expect(r.answerAr).toBeNull();
    expect(r.evidenceCount).toBe(2);
    expect(r.gapIds).toEqual(['g1', 'g2']);
    expect(r.notes).toBe(
      'Drafted from 2 team replies, 2026-11-10. Check before approving.'
    );
    // The small model, logged as kb_learn.
    expect(d.generate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-small', purpose: 'kb_learn' })
    );
    expect(d.logUsage).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'kb_learn', conversationId: null })
    );
  });

  it('fails closed: a text the redactor cannot screen skips the topic', async () => {
    const store = fakeStore({
      gaps: async () => [
        { ...gap('g1', 'c1'), question: 42 as unknown as string },
        gap('g2', 'c2'),
      ],
    });
    const d = deps(store);
    const out = await learnTopic(d, ACCOUNT, CONFIG, {
      id: 't1',
      label: 'x',
      coverage: 'none',
    });
    expect(out).toEqual({ drafted: false, reason: 'redaction' });
    expect(d.generate).not.toHaveBeenCalled();
    expect(store.recorded).toHaveLength(0);
  });

  it('skips covered, already drafted and unanswered topics without the model', async () => {
    for (const [store, topicCoverage, reason] of [
      [fakeStore(), 'full', 'covered'],
      [fakeStore({ topicDrafted: async () => true }), 'none', 'already'],
      [fakeStore({ threads: { c1: null, c2: null } }), 'none', 'no_answers'],
      [
        fakeStore({
          threads: {
            c1: {
              messages: [{ ...reply('auto'), sender_id: null }],
              contactName: null,
              senderNames: { 'agent-user': 'Yusuf Ali' },
            },
          },
        }),
        'none',
        'no_answers',
      ],
    ] as const) {
      const d = deps(store);
      const out = await learnTopic(d, ACCOUNT, CONFIG, {
        id: 't1',
        label: 'x',
        coverage: topicCoverage,
      });
      expect(out).toEqual({ drafted: false, reason });
      expect(d.generate).not.toHaveBeenCalled();
    }
  });

  it('asks for Arabic too when the team answers in Arabic', async () => {
    const store = fakeStore({
      threads: {
        c1: {
          messages: [reply('نعم يمكنك فتح الحساب برخصة عمل حر')],
          contactName: null,
          senderNames: { 'agent-user': 'Yusuf Ali' },
        },
        c2: {
          messages: [reply('نعم، تكفي رخصة العمل الحر')],
          contactName: null,
          senderNames: { 'agent-user': 'Yusuf Ali' },
        },
      },
    });
    const d = deps(store, {
      generate: vi.fn(async () => ({
        text: '{"question":"Can I open an account without a trade licence?","answer_en":"Yes, with a freelance permit.","answer_ar":"نعم، برخصة عمل حر."}',
        handoff: false,
        usage: null,
      })),
    });
    await learnTopic(d, ACCOUNT, CONFIG, {
      id: 't1',
      label: 'x',
      coverage: 'none',
    });
    expect(store.recorded[0]?.answerAr).toBe('نعم، برخصة عمل حر.');
  });

  it('throws nothing away silently: an unusable answer is not drafted', async () => {
    const store = fakeStore();
    const d = deps(store, {
      generate: vi.fn(async () => ({
        text: '{"question":"Can I open an account without a trade licence?","answer_en":"Ask [NAME] on +971 50 123 4567."}',
        handoff: false,
        usage: null,
      })),
    });
    const out = await learnTopic(d, ACCOUNT, CONFIG, {
      id: 't1',
      label: 'x',
      coverage: 'none',
    });
    expect(out).toEqual({ drafted: false, reason: 'discarded' });
    expect(store.recorded).toHaveLength(0);
  });

  it('retries a taken ref once, and stops on disabled', async () => {
    const results = ['ref_taken', 'drafted'] as const;
    let i = 0;
    const store = fakeStore({ recordDraft: async () => results[i++]! });
    expect(
      await learnTopic(deps(store), ACCOUNT, CONFIG, {
        id: 't1',
        label: 'x',
        coverage: 'none',
      })
    ).toEqual({ drafted: true });
    const off = fakeStore({ recordDraft: async () => 'disabled' });
    expect(
      await learnTopic(deps(off), ACCOUNT, CONFIG, {
        id: 't1',
        label: 'x',
        coverage: 'none',
      })
    ).toEqual({ drafted: false, reason: 'disabled' });
  });

  it('a refused transfer (224) drafts nothing', async () => {
    const store = fakeStore();
    const d = deps(store, {
      generate: vi.fn(async () => {
        throw new Error('transfer_basis_required');
      }),
    });
    const out = await learnTopic(d, ACCOUNT, CONFIG, {
      id: 't1',
      label: 'x',
      coverage: 'none',
    });
    expect(out).toEqual({ drafted: false, reason: 'model' });
    expect(store.recorded).toHaveLength(0);
  });
});

describe('learnTopic evidence', () => {
  it('needs two team answers from different chats', async () => {
    const store = fakeStore({
      threads: {
        c1: {
          messages: [reply('Yes, a freelance permit works.')],
          contactName: null,
          senderNames: { 'agent-user': 'Yusuf Ali' },
        },
        c2: null,
      },
    });
    const d = deps(store);
    expect(
      await learnTopic(d, ACCOUNT, CONFIG, {
        id: 't1',
        label: 'x',
        coverage: 'none',
      })
    ).toEqual({ drafted: false, reason: 'no_answers' });
    expect(d.generate).not.toHaveBeenCalled();
  });

  it('sends the chat text fenced as evidence', async () => {
    const store = fakeStore();
    const d = deps(store);
    await learnTopic(d, ACCOUNT, CONFIG, {
      id: 't1',
      label: 'x',
      coverage: 'none',
    });
    const user = d.sent[1]!;
    expect(user.indexOf('<evidence>')).toBeLessThan(
      user.indexOf('freelance permit')
    );
    expect(user.trimEnd().endsWith('</evidence>')).toBe(true);
  });
});

describe('back-off, gaps and usage', () => {
  const topic = { id: 't1', label: 'x', coverage: 'none' };
  const usage = { promptTokens: 9, completionTokens: 1, totalTokens: 10 };

  it('records a declined, malformed or cut-off answer in the ledger', async () => {
    const answers: (() => Promise<never> | Promise<unknown>)[] = [
      async () => ({ text: '{"question":null,"answer_en":null}', usage }),
      async () => ({ text: 'not json', usage }),
      async () => {
        throw new AiError('cut', { code: 'truncated', usage });
      },
    ];
    for (const generate of answers) {
      const recordDiscard = vi.fn(async () => {});
      const d = deps(fakeStore({ recordDiscard }), {
        generate: generate as unknown as KbLearnDeps['generate'],
      });
      expect(await learnTopic(d, ACCOUNT, CONFIG, topic)).toEqual({
        drafted: false,
        reason: 'unusable',
      });
      expect(recordDiscard).toHaveBeenCalledTimes(1);
      // Billed, so logged: the cut-off call too.
      expect(d.logUsage).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'kb_learn', usage })
      );
    }
  });

  it('a network failure is not the topic’s: no back-off', async () => {
    const recordDiscard = vi.fn(async () => {});
    const d = deps(fakeStore({ recordDiscard }), {
      generate: async () => {
        throw new AiError('down', { code: 'network_error' });
      },
    });
    const out = await learnTopic(d, ACCOUNT, CONFIG, topic);
    expect(out.reason).toBe('model');
    expect(recordDiscard).not.toHaveBeenCalled();
  });

  it('reads the newest 25 gaps, and records them all', async () => {
    const gapIds = Array.from({ length: 1200 }, (_, i) => `n${i}`);
    const gaps = vi.fn(async () => [gap('g1', 'c1'), gap('g2', 'c2')]);
    const store = fakeStore({ gaps });
    await learnTopic(deps(store), ACCOUNT, CONFIG, { ...topic, gapIds });
    expect(gaps).toHaveBeenCalledWith(ACCOUNT, gapIds.slice(0, 25));
    expect(store.recorded[0]!.gapIds).toHaveLength(1200);
  });

  it('takes the open topics, and their gaps in order, from the query', async () => {
    const asked = vi.fn((a: Record<string, unknown>) => {
      void a;
      return [{ id: 't', label: 'l', coverage: 'none', gap_ids: ['b', 'a'] }];
    });
    const store = supabaseKbLearnStore(
      fakeDb({}, {}, { kb_learn_open_topics: asked })
    );
    expect(await store.openTopics(ACCOUNT)).toEqual([
      { id: 't', label: 'l', coverage: 'none', gapIds: ['b', 'a'] },
    ]);
    expect(asked.mock.calls[0]![0]).toMatchObject({ p_account: ACCOUNT });
  });

  it('needs the AI master switch on', async () => {
    await defaultDeps().loadConfig(ACCOUNT);
    const opts = (loadAiConfig.mock.calls[0] as unknown[])[2] as
      { requireActive?: boolean } | undefined;
    expect(opts?.requireActive ?? true).toBe(true);
  });
});

/** `n` topics with answers each. */
const topics = (n: number) => async () =>
  Array.from({ length: n }, (_, k) => ({
    id: `t${k}`,
    label: `topic ${k}`,
    coverage: 'none',
    gapIds: ['g1', 'g2'],
  }));
const down = async () => {
  throw new Error('db down');
};
const modelDown = async () => {
  throw new AiError('down', { code: 'network_error' });
};

describe('learnAccount', () => {
  it('caps topics per run at ten', async () => {
    const d = deps(fakeStore({ openTopics: topics(15) }));
    expect(await learnAccount(d, ACCOUNT, CONFIG, 1e9)).toEqual({
      drafted: 10,
      tried: 10,
      error: null,
    });
  });

  it('the topics asked in the last 7 days count toward the ten', async () => {
    for (const [asked, left] of [
      [7, 3],
      [10, 0],
      [12, 0],
    ]) {
      const knownNames = vi.fn(async () => []);
      const d = deps(
        fakeStore({
          openTopics: topics(15),
          askedThisWeek: async () => asked!,
          knownNames,
        })
      );
      expect(await learnAccount(d, ACCOUNT, CONFIG, 1e9)).toEqual({
        drafted: left,
        tried: left,
        error: null,
      });
      expect(d.generate).toHaveBeenCalledTimes(left!);
      // Nothing left: done for the week without reading the names.
      expect(knownNames).toHaveBeenCalledTimes(left ? 1 : 0);
    }
  });

  it('hourly out-of-time retries never ask more than ten', async () => {
    const ledger: string[] = [];
    let clock = 0;
    const store = fakeStore({
      openTopics: async () =>
        (await topics(30)()).filter((t) => !ledger.includes(t.id)),
      askedThisWeek: async () => ledger.length,
      recordDraft: async (a) => {
        ledger.push(a.topicId);
        clock += 10_000;
        return 'drafted';
      },
    });
    const d = deps(store, { now: () => clock });
    const errors = [];
    for (let i = 0; i < 4; i++)
      errors.push(
        (await learnAccount(d, ACCOUNT, CONFIG, clock + 45_000)).error
      );
    expect(errors).toEqual(['out_of_time', 'out_of_time', null, null]);
    expect(ledger).toHaveLength(10);
  });

  it('starts no topic after its time budget, and says so', async () => {
    const d = deps(fakeStore());
    expect(
      await learnAccount(d, ACCOUNT, CONFIG, TOPIC_MIN_BUDGET_MS - 1)
    ).toEqual({ drafted: 0, tried: 0, error: 'out_of_time' });
  });

  it('a failed read is an error, never a quiet success', async () => {
    for (const over of [
      { askedThisWeek: down },
      { openTopics: down },
      { knownNames: down },
      { thread: down },
      { gaps: down },
      { topicDrafted: down },
    ]) {
      const d = deps(fakeStore(over as Partial<KbLearnStore>));
      expect(await learnAccount(d, ACCOUNT, CONFIG, 1e9)).toEqual({
        drafted: 0,
        tried: 0,
        error: 'read_failed',
      });
      expect(d.generate).not.toHaveBeenCalled();
    }
  });

  it('a topic that cannot be read does not hide that the ten were asked', async () => {
    let first = true;
    const store = fakeStore({
      openTopics: topics(15),
      topicDrafted: async () => {
        if (first) {
          first = false;
          throw new Error('timeout');
        }
        return false;
      },
    });
    expect(await learnAccount(deps(store), ACCOUNT, CONFIG, 1e9)).toEqual({
      drafted: 10,
      tried: 10,
      error: null,
    });
  });

  it('stops after three model failures in a row', async () => {
    const generate = vi.fn(modelDown);
    const d = deps(fakeStore({ openTopics: topics(9) }), { generate });
    expect(await learnAccount(d, ACCOUNT, CONFIG, 1e9)).toEqual({
      drafted: 0,
      tried: 3,
      error: 'model',
    });
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('a lone model failure is passed over, one at the end is not', async () => {
    const good = deps(fakeStore()).generate;
    const run = (failing: number[]) => {
      let i = 0;
      return learnAccount(
        deps(fakeStore({ openTopics: topics(4) }), {
          generate: (a) => (failing.includes(i++) ? modelDown() : good(a)),
        }),
        ACCOUNT,
        CONFIG,
        1e9
      );
    };
    expect(await run([0, 2])).toMatchObject({ drafted: 2, error: null });
    expect(await run([3])).toMatchObject({ drafted: 3, error: 'model' });
  });

  it('stops when the ledger cannot note an asked topic', async () => {
    const unusable = async () => ({
      text: 'not json',
      handoff: false,
      usage: null,
    });
    for (const [over, generate] of [
      [{ recordDraft: async () => 'error' }, undefined],
      [{ recordDiscard: down }, unusable],
    ] as const) {
      const d = deps(
        fakeStore({
          openTopics: topics(5),
          ...(over as Partial<KbLearnStore>),
        }),
        generate ? { generate } : {}
      );
      expect(await learnAccount(d, ACCOUNT, CONFIG, 1e9)).toEqual({
        drafted: 0,
        tried: 1,
        error: 'failed',
      });
    }
  });

  it('an answer the database refuses is noted, so it counts this week', async () => {
    const recordDiscard = vi.fn(async () => {});
    const store = fakeStore({
      recordDraft: async () => 'invalid',
      recordDiscard,
    });
    expect(await learnAccount(deps(store), ACCOUNT, CONFIG, 1e9)).toEqual({
      drafted: 0,
      tried: 1,
      error: null,
    });
    expect(recordDiscard).toHaveBeenCalledTimes(1);
  });

  it('the switch going off ends the run without an error', async () => {
    const store = fakeStore({
      openTopics: topics(5),
      recordDraft: async () => 'disabled',
    });
    expect(await learnAccount(deps(store), ACCOUNT, CONFIG, 1e9)).toEqual({
      drafted: 0,
      tried: 0,
      error: null,
    });
  });
});

describe('runKbLearning', () => {
  it('runs only claimed accounts', async () => {
    const store = fakeStore({
      dueAccounts: async () => ['a', 'b'],
      claimRun: async (id) => id === 'b',
    });
    const res = await runKbLearning(deps(store));
    expect(res).toEqual({ accounts: 1, drafted: 1 });
    // The switch's "last run" line: one draft, for the claimed account.
    expect(store.finished).toEqual([['b', 1, null]]);
  });

  it('loads the AI config before claiming; without one, says so', async () => {
    const steps: string[] = [];
    const store = fakeStore({
      claimRun: async () => {
        steps.push('claim');
        return true;
      },
      askedThisWeek: async () => {
        steps.push('read');
        return 0;
      },
    });
    const d = deps(store, {
      loadConfig: async () => {
        steps.push('config');
        return null;
      },
    });
    expect(await runKbLearning(d)).toEqual({ accounts: 1, drafted: 0 });
    expect(steps).toEqual(['config', 'claim']);
    expect(store.finished).toEqual([[ACCOUNT, 0, 'no_ai']]);
    expect(d.generate).not.toHaveBeenCalled();
  });

  it('an AI config that cannot be read is a failed read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = fakeStore();
    await runKbLearning(deps(store, { loadConfig: down }));
    expect(store.finished).toEqual([[ACCOUNT, 0, 'read_failed']]);
    error.mockRestore();
  });

  it('records why a run failed, and runs the next account', async () => {
    const store = fakeStore({
      dueAccounts: async () => ['a', 'b'],
      openTopics: async (id) => (id === 'a' ? down() : topics(1)()),
    });
    expect(await runKbLearning(deps(store))).toEqual({
      accounts: 2,
      drafted: 1,
    });
    expect(store.finished).toEqual([
      ['a', 0, 'read_failed'],
      ['b', 1, null],
    ]);
  });

  it('a failed run record does not stop the pass', async () => {
    const store = fakeStore({
      dueAccounts: async () => ['a', 'b'],
      finishRun: async () => {
        throw new Error('db down');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await runKbLearning(deps(store))).toEqual({
      accounts: 2,
      drafted: 2,
    });
    warn.mockRestore();
  });

  it('never throws when the account scan fails', async () => {
    const store = fakeStore({
      dueAccounts: async () => {
        throw new Error('db down');
      },
    });
    await expect(runKbLearning(deps(store))).resolves.toEqual({
      accounts: 0,
      drafted: 0,
    });
  });
});

describe('privacy', () => {
  const LABEL =
    'I am Ahmed Khan of Al Noor Trading, case TC-20451 was refused, can I reapply?';
  const topic = { id: 't1', label: LABEL, coverage: 'none' };
  const draft = (question: string, answer = 'Yes, after three months.') =>
    vi.fn(async () => ({
      text: JSON.stringify({ question, answer_en: answer }),
      handoff: false,
      usage: null,
    }));

  it('never sends or stores the label; the question is masked and general', async () => {
    const store = fakeStore({
      gaps: async () => [
        { ...gap('g1', 'c1'), question: LABEL },
        { ...gap('g2', 'c2'), question: 'وأحمد يسأل لمحمد' },
      ],
    });
    const sent: string[] = [];
    const generate = draft('Can I reapply after a refusal?');
    const d = deps(store, {
      generate: vi.fn(async (a) => {
        sent.push(...a.messages.map((m: { content: string }) => m.content));
        return (generate as () => ReturnType<typeof generate>)();
      }),
    });
    const names = ['Ahmed Khan', 'Al Noor Trading LLC', 'محمد', 'أحمد'];
    expect(await learnTopic(d, ACCOUNT, CONFIG, topic, names)).toEqual({
      drafted: true,
    });
    const all = sent.join('\n');
    expect(all).toContain('can I reapply?');
    for (const bad of ['Ahmed', 'Khan', 'Noor', '20451', 'محمد', 'حمد'])
      expect(all).not.toContain(bad);
    const stored = JSON.stringify(store.recorded);
    expect(store.recorded[0]!.question).toBe('Can I reapply after a refusal?');
    for (const bad of ['Ahmed', 'Khan', 'Noor', '20451'])
      expect(stored).not.toContain(bad);
  });

  it('the label of a chat that may not be learned from is not sent', async () => {
    const store = fakeStore({
      gaps: async () => [
        { ...gap('g0', 'hr'), question: 'salary certificate complaint' },
        gap('g1', 'c1'),
        gap('g2', 'c2'),
      ],
    });
    const d = deps(store);
    await learnTopic(d, ACCOUNT, CONFIG, {
      ...topic,
      gapIds: ['g0', 'g1', 'g2'],
      label: 'salary certificate complaint',
    });
    expect(d.sent.length).toBeGreaterThan(0);
    expect(d.sent.join()).not.toContain('complaint');
  });

  it('a name in the model’s output discards the draft, recorded', async () => {
    for (const generate of [
      draft('Can Ahmed Khan reapply?'),
      draft('Can I reapply?', 'Yes, ask Priya.'),
    ]) {
      const recordDiscard = vi.fn(async () => {});
      const store = fakeStore({ recordDiscard });
      const out = await learnTopic(
        deps(store, { generate }),
        ACCOUNT,
        CONFIG,
        topic,
        ['Ahmed Khan', 'Priya Nair']
      );
      expect(out).toEqual({ drafted: false, reason: 'discarded' });
      expect(store.recorded).toHaveLength(0);
      expect(recordDiscard).toHaveBeenCalledWith(
        expect.objectContaining({ topicKey: topicKey(ACCOUNT, LABEL) })
      );
    }
  });

  it('skips a thread whose answering sender has no name', async () => {
    const t = (senderNames: Record<string, string>): LearnThread => ({
      messages: [reply('Yes, a permit works.')],
      contactName: 'Omar',
      senderNames,
    });
    const store = fakeStore({
      threads: { c1: t({ 'agent-user': 'Yusuf' }), c2: t({}) },
    });
    expect(await learnTopic(deps(store), ACCOUNT, CONFIG, topic)).toEqual({
      drafted: false,
      reason: 'no_answers',
    });
  });

  it('sends nothing when the name list cannot be read', async () => {
    const store = fakeStore({
      knownNames: async () => {
        throw new Error('timeout');
      },
    });
    const d = deps(store);
    expect(await learnAccount(d, ACCOUNT, CONFIG, 1e9)).toEqual({
      drafted: 0,
      tried: 0,
      error: 'read_failed',
    });
    expect(d.generate).not.toHaveBeenCalled();
  });
});

// A chainable stand-in for the service client: each table answers the
// rows a filter leaves, or the error set for it.
function fakeDb(
  tables: Record<string, Record<string, unknown>[]>,
  errors: Record<string, string> = {},
  rpcs: Record<string, (args: Record<string, unknown>) => unknown> = {}
) {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const answer = (data: unknown) =>
      errors[table]
        ? { data: null, error: { message: errors[table] } }
        : { data, error: null };
    const q: Record<string, unknown> = {
      then: (done: (v: unknown) => void) => done(answer(rows)),
      maybeSingle: async () => answer(rows[0] ?? null),
      limit: (n: number) => {
        rows = rows.slice(0, n);
        return q;
      },
      gt: (col: string, v: string) => {
        rows = rows.filter((r) => String(r[col]) > v);
        return q;
      },
      lte: (col: string, v: string) => {
        rows = rows.filter((r) => String(r[col]) <= v);
        return q;
      },
    };
    q.is = (col: string, v: unknown) => {
      rows = rows.filter((r) => (r[col] ?? null) === v);
      return q;
    };
    q.not = (col: string, _op: string, v: unknown) => {
      rows = rows.filter((r) => (r[col] ?? null) !== v);
      return q;
    };
    for (const name of ['select', 'eq', 'in', 'order']) q[name] = () => q;
    return q;
  };
  const rpc = async (name: string, args: Record<string, unknown>) =>
    errors[name]
      ? { data: null, error: { message: errors[name] } }
      : { data: rpcs[name]?.(args) ?? null, error: null };
  return { from, rpc } as unknown as Parameters<typeof supabaseKbLearnStore>[0];
}

describe('supabaseKbLearnStore.thread', () => {
  const tables = {
    conversations: [
      {
        id: 'c',
        contact_id: 'k',
        personal_owner_id: null,
        inbox_department: null as string | null,
      },
    ],
    contacts: [{ name: 'Omar', opted_out_at: null, do_not_contact_at: null }],
    messages: [{ ...reply('Yes, it works.'), channel_id: 'line-1' }],
    profiles: [{ user_id: 'agent-user', full_name: 'Yusuf Ali' }],
    hr_conversations: [] as Record<string, unknown>[],
  };
  const thread = (db: ReturnType<typeof fakeDb>) =>
    supabaseKbLearnStore(db).thread(ACCOUNT, 'c', GAP_AT, at(2880));

  it('reads a sales chat', async () => {
    expect((await thread(fakeDb(tables)))?.senderNames).toEqual({
      'agent-user': 'Yusuf Ali',
    });
  });
  it('leaves out HR, IT and accounts chats, and HR lines', async () => {
    const line = { hr_is_line: (a: Record<string, unknown>) => a.p_channel };
    for (const dep of ['hr', 'it', 'accounts'])
      expect(
        await thread(
          fakeDb({
            ...tables,
            conversations: [
              { ...tables.conversations[0]!, inbox_department: dep },
            ],
          })
        )
      ).toBeNull();
    expect(
      await thread(
        fakeDb({ ...tables, hr_conversations: [{ conversation_id: 'c' }] })
      )
    ).toBeNull();
    // A reply on an HR line, and a question that came in on one.
    const onLine = { hr_is_line: () => true };
    expect(await thread(fakeDb(tables, {}, onLine))).toBeNull();
    const asked = {
      ...reply('question', -1),
      sender_type: 'customer',
      channel_id: 'hr-line',
    };
    expect(
      await thread(
        fakeDb(
          { ...tables, messages: [...tables.messages, asked] },
          {},
          {
            hr_is_line: (a) => line.hr_is_line(a) === 'hr-line',
          }
        )
      )
    ).toBeNull();
  });
  it('throws when any of its reads fails', async () => {
    for (const broken of [
      'conversations',
      'contacts',
      'messages',
      'profiles',
      'hr_conversations',
      'hr_is_line',
    ])
      await expect(
        thread(fakeDb(tables, { [broken]: 'timeout' }))
      ).rejects.toThrow('timeout');
  });
});

describe('supabaseKbLearnStore.knownNames', () => {
  const contacts = Array.from({ length: 1001 }, (_, i) => ({
    id: `id-${String(i).padStart(5, '0')}`,
    name: `Person ${i}`,
    company: i === 1000 ? 'Last Page Co' : null,
  }));
  it('reads past 1,000 rows, and every source', async () => {
    const names = await supabaseKbLearnStore(
      fakeDb(
        {
          contacts,
          profiles: [{ id: 'p', full_name: 'Yusuf Ali' }],
          submission_groups: [{ id: 's', customer_name: 'Case Co' }],
        },
        {},
        {
          kb_learn_case_names: (a) => (a.p_after ? [] : ['Bank Person']),
        }
      )
    ).knownNames(ACCOUNT);
    // Case names are people or companies: kept as both.
    expect(names).toHaveLength(1006);
    for (const n of [
      { name: 'Person 1000', kind: 'person' },
      { name: 'Last Page Co', kind: 'company' },
      { name: 'Yusuf Ali', kind: 'person' },
      { name: 'Case Co', kind: 'company' },
      { name: 'Bank Person', kind: 'person' },
      { name: 'Bank Person', kind: 'company' },
    ])
      expect(names).toContainEqual(n);
  });
  it('throws when any source fails', async () => {
    for (const t of [
      'contacts',
      'profiles',
      'submission_groups',
      'kb_learn_case_names',
    ])
      await expect(
        supabaseKbLearnStore(
          fakeDb({}, { [t]: 'timeout' }, { kb_learn_case_names: () => [] })
        ).knownNames(ACCOUNT)
      ).rejects.toThrow('timeout');
  });
});

describe('supabaseKbLearnStore runs', () => {
  it('asks for what is due, the longest due first, old rows too', async () => {
    const asked: Record<string, unknown[]> = {};
    const q: Record<string, unknown> = {
      then: (done: (v: unknown) => void) =>
        done({ data: [{ account_id: 'a' }], error: null }),
    };
    for (const name of ['select', 'eq', 'or', 'order', 'limit'])
      q[name] = (...args: unknown[]) => {
        asked[name] = args;
        return q;
      };
    const db = { from: () => q } as unknown as ReturnType<typeof fakeDb>;
    expect(
      await supabaseKbLearnStore(db).dueAccounts(
        new Date('2026-11-24T10:00:00.000Z')
      )
    ).toEqual(['a']);
    expect(asked.eq).toEqual(['enabled', true]);
    expect(asked.order).toEqual([
      'next_run_at',
      { ascending: true, nullsFirst: true },
    ]);
    expect(asked.or).toEqual([
      'next_run_at.lte.2026-11-24T10:00:00.000Z,' +
        'and(next_run_at.is.null,last_run_at.is.null),' +
        'and(next_run_at.is.null,last_run_at.lte.2026-11-17T10:00:00.000Z)',
    ]);
  });

  it('hands the error code over, and reads the count', async () => {
    const finish = vi.fn((a: Record<string, unknown>) => void a);
    const store = supabaseKbLearnStore(
      fakeDb(
        {},
        {},
        {
          kb_learn_finish_run: finish,
          kb_learn_asked_this_week: () => 4,
          kb_learn_record_discard: () => false,
        }
      )
    );
    await store.finishRun(ACCOUNT, 2, 'model');
    expect(finish).toHaveBeenCalledWith({
      p_account: ACCOUNT,
      p_drafted: 2,
      p_error: 'model',
    });
    expect(await store.askedThisWeek(ACCOUNT)).toBe(4);
    // A count that is not one, or a discard not written, is a failure.
    await expect(
      supabaseKbLearnStore(fakeDb({})).askedThisWeek(ACCOUNT)
    ).rejects.toThrow('no count');
    await expect(
      store.recordDiscard({
        accountId: ACCOUNT,
        topicId: 't',
        topicKey: 'k',
        gapIds: [],
        evidenceCount: 2,
      })
    ).rejects.toThrow('not written');
  });
});

describe('looks and claims', () => {
  it('one account whose claim throws does not end the pass', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = fakeStore({
      dueAccounts: async () => ['bad', ACCOUNT],
      claimRun: async (id) => {
        if (id === 'bad') throw new Error('claim: down');
        return true;
      },
    });
    const res = await runKbLearning(deps(store));
    expect(res).toEqual({ accounts: 1, drafted: 1 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('bad'));
    error.mockRestore();
  });

  it('notes every topic looked at, and whether the model failed', async () => {
    const looks: [string[], boolean][] = [];
    const noteLook: KbLearnStore['noteLook'] = async (_a, ids, failed) => {
      looks.push([ids, failed]);
    };
    const quiet = fakeStore({ noteLook, threads: {} });
    await learnAccount(deps(quiet), ACCOUNT, CONFIG, 1e9);
    const failing = deps(fakeStore({ noteLook }), {
      generate: vi.fn(async () => {
        throw new Error('network');
      }),
    });
    await learnAccount(failing, ACCOUNT, CONFIG, 1e9);
    expect(looks).toEqual([
      [['g1', 'g2'], false],
      [['g1', 'g2'], true],
    ]);
  });

  it('the topic key is an HMAC with a secret the database does not hold', () => {
    const before = process.env.ENCRYPTION_KEY;
    const one = topicKey(ACCOUNT, 'x');
    process.env.ENCRYPTION_KEY = 'another secret';
    expect(topicKey(ACCOUNT, 'x')).not.toBe(one);
    delete process.env.ENCRYPTION_KEY;
    expect(() => topicKey(ACCOUNT, 'x')).toThrow();
    process.env.ENCRYPTION_KEY = before;
  });
});

describe('evolveSkills (the skill library, 318)', () => {
  const NAMES = buildNameMatcher(['Sara Haddad', 'Al Noor Trading']);
  const ANSWER = 'A freelance permit works instead of a trade licence.';
  const entry = (status: string, over = {}): ReviewRow['entry'] => ({
    status,
    question: 'Account without a trade licence?',
    answer_en: ANSWER,
    ...over,
  });
  const row = (
    id: string,
    e: ReviewRow['entry'],
    over: Partial<ReviewRow> = {}
  ): ReviewRow => ({
    id,
    draftAnswer: ANSWER,
    outcome: null,
    distilled: false,
    entry: e,
    ...over,
  });
  const five = () =>
    ['a', 'b', 'c', 'd', 'e'].map((id) => row(id, entry('approved')));

  function skillStore(rows: ReviewRow[], over: Partial<KbLearnStore> = {}) {
    const marked: { id: string; outcome: string }[] = [];
    const added: { skills: Skill[]; reviewIds: string[] }[] = [];
    const store = fakeStore({
      reviewRows: async () => rows,
      markReviewed: async (_a, r) => {
        marked.push(...r);
      },
      addSkills: async (_a, skills, reviewIds) => {
        added.push({ skills, reviewIds });
        return skills.length;
      },
      ...over,
    });
    return { store, marked, added };
  }
  const skillModel = (skills: unknown[], sent: string[] = []) =>
    vi.fn(
      async (a: { systemPrompt: string; messages: { content: string }[] }) => {
        sent.push(a.systemPrompt, ...a.messages.map((m) => m.content));
        return {
          text: JSON.stringify({ skills }),
          handoff: false,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      }
    ) as unknown as KbLearnDeps['generate'];
  const evolve = (d: KbLearnDeps, deadline = 1e9) =>
    evolveSkills(d, ACCOUNT, CONFIG, NAMES, deadline);
  const stored = (over: Partial<Skill>): Skill => ({
    kind: 'general',
    category: null,
    title: 'Name the documents',
    principle: 'List what to bring.',
    whenToApply: null,
    evidenceCount: 3,
    ...over,
  });

  it('classifies reviews and waits for enough of them', async () => {
    const { store, marked, added } = skillStore([
      row('r1', entry('approved')),
      row('r2', entry('draft')),
      row('r3', null),
    ]);
    const d = deps(store);
    expect(await evolve(d)).toMatchObject({
      classified: 2,
      evolved: false,
      added: 0,
    });
    expect(marked).toEqual([
      { id: 'r1', outcome: 'approved' },
      { id: 'r3', outcome: 'deleted' },
    ]);
    expect(d.generate).not.toHaveBeenCalled();
    expect(added).toHaveLength(0);
  });

  it('an erased or pre-318 draft is never a rejection', async () => {
    const gone = { draftAnswer: null };
    const { store, marked } = skillStore([
      ...['a', 'b', 'c', 'd', 'e'].map((id) => row(id, null, gone)),
      row('f', null, { ...gone, outcome: 'deleted' }),
    ]);
    const d = deps(store);
    expect(await evolve(d)).toMatchObject({ classified: 0, reason: null });
    expect(marked).toEqual([]);
    expect(d.generate).not.toHaveBeenCalled();
  });

  it('on a low approval rate sends masked examples only, adds safe rules', async () => {
    const { store, added } = skillStore(
      [
        row('r1', null, {
          draftAnswer:
            'Sara Haddad said: call +971 50 123 4567 or sara.ali@example.com',
        }),
        row('r2', entry('remove', { question: 'Is Al Noor Trading ok?' })),
        row('r3', entry('remove')),
        row('r4', entry('remove')),
        row('r5', entry('approved'), { outcome: 'approved', distilled: true }),
      ],
      {
        activeSkills: async () => [
          stored({}),
          stored({ title: 'About Haddad' }),
        ],
      }
    );
    const sent: string[] = [];
    const d = deps(store, {
      generate: skillModel(
        [
          {
            kind: 'mistake',
            title: 'Promising approval',
            principle: 'Do not promise approval; the bank decides.',
          },
          { kind: 'general', title: 'Leaky', principle: '+971 50 123 4567.' },
          { kind: 'general', title: 'Named', principle: 'Ask Haddad first.' },
        ],
        sent
      ),
    });
    expect(await evolve(d)).toMatchObject({
      evolved: true,
      reason: 'low_approval',
      added: 1,
    });
    const all = sent.join('\n');
    expect(all).toContain('REJECTED (deleted)');
    expect(all).toContain('[general] Name the documents');
    for (const bad of ['Sara', 'Haddad', 'Noor', '123 4567', 'sara.ali'])
      expect(all).not.toContain(bad);
    expect(added[0]!.skills.map((s) => s.title)).toEqual([
      'Promising approval',
    ]);
    // Only the reviews not distilled yet are marked.
    expect(added[0]!.reviewIds).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(d.logUsage).toHaveBeenCalledTimes(1);
    expect(d.logUsage).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'kb_learn' })
    );
  });

  it('asks nothing: no time, switch off, learned this week, no room', async () => {
    const now = Date.parse('2026-11-24T10:00:00Z');
    const last = (ms: number) => async () => ({
      enabled: true,
      lastDistilledAt: new Date(now - ms).toISOString(),
    });
    const full = Array.from({ length: 24 }, (_, i) =>
      stored({ title: `${i}` })
    );
    const cases: [boolean, Partial<KbLearnStore>, number?][] = [
      [true, {}, EVOLVE_MIN_BUDGET_MS],
      [false, {}, EVOLVE_MIN_BUDGET_MS - 1],
      [
        false,
        {
          distillState: async () => ({ enabled: false, lastDistilledAt: null }),
        },
      ],
      [false, { distillState: last(EVOLVE_INTERVAL_MS - 1) }],
      [true, { distillState: last(EVOLVE_INTERVAL_MS) }],
      [false, { activeSkills: async () => full }],
    ];
    for (const [asks, over, budget = 1e9] of cases) {
      const { store } = skillStore(five(), over);
      const d = deps(store, { generate: skillModel([]), now: () => now });
      expect((await evolve(d, now + budget)).evolved).toBe(asks);
      expect(d.generate).toHaveBeenCalledTimes(asks ? 1 : 0);
    }
  });

  it('logs a failed call that was billed, and does not ask it again', async () => {
    const usage = { promptTokens: 9, completionTokens: 1, totalTokens: 10 };
    const { store, added } = skillStore(five());
    const d = deps(store, {
      generate: async () => {
        throw new AiError('cut', { code: 'truncated', usage });
      },
    });
    expect(await evolve(d)).toMatchObject({ evolved: true, added: 0 });
    expect(d.logUsage).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'kb_learn', usage })
    );
    expect(added).toEqual([
      { skills: [], reviewIds: ['a', 'b', 'c', 'd', 'e'] },
    ]);
  });

  it('a failure never stops the drafting', async () => {
    const fail = async () => {
      throw new Error('db down');
    };
    for (const over of [
      { reviewRows: fail },
      { distillState: fail },
      { activeSkills: fail },
      { addSkills: fail },
    ]) {
      const { store } = skillStore(five(), over);
      expect(await learnAccount(deps(store), ACCOUNT, CONFIG, 1e9)).toEqual({
        drafted: 1,
        tried: 1,
        error: null,
      });
    }
  });

  it('no names, no topics or no calls left this week: no call', async () => {
    for (const over of [
      {
        knownNames: async () => {
          throw new Error('timeout');
        },
      },
      { openTopics: async () => [] },
      { askedThisWeek: async () => 10 },
    ]) {
      const { store, marked } = skillStore(five(), over);
      const d = deps(store);
      await learnAccount(d, ACCOUNT, CONFIG, 1e9);
      expect(d.generate).not.toHaveBeenCalled();
      expect(marked).toEqual([]);
    }
  });

  it('a draft’s prompt gets the rules that fit, screened again', async () => {
    const store = fakeStore({
      openTopics: async () => [
        {
          id: 't1',
          label: 'Monthly fee zebra?',
          coverage: 'none',
          gapIds: ['g1', 'g2'],
        },
      ],
      knownNames: async () => ['Sara Haddad'],
      activeSkills: async () => [
        stored({}),
        stored({ title: 'Ask Haddad' }),
        // A name of one of the topic's own chats.
        stored({ title: 'Ask Fatima' }),
        stored({ kind: 'category', category: 'fees', title: 'Fee rule' }),
        stored({ kind: 'category', category: 'pos', title: 'POS rule' }),
      ],
    });
    const d = deps(store);
    await learnAccount(d, ACCOUNT, CONFIG, 1e9);
    const system = d.sent[0]!;
    expect(system).toContain('House rules');
    expect(system).toContain('Name the documents');
    expect(system).toContain('Fee rule');
    expect(system).not.toContain('POS rule');
    for (const bad of ['Haddad', 'Fatima', 'zebra'])
      expect(d.sent.join('\n')).not.toContain(bad);
  });

  it('the store reads reviewed drafts only, and the erase race as neither', async () => {
    const base = {
      draft_answer_en: ANSWER,
      entry_id: null,
      discarded_at: null,
      reviewed_outcome: null,
      distilled_at: null,
    };
    const store = supabaseKbLearnStore(
      fakeDb({
        kb_learned_drafts: [
          { ...base, id: 'deleted' },
          { ...base, id: 'kept', entry_id: 'e1', distilled_at: 'x' },
          { ...base, id: 'gone', entry_id: 'e2' },
          { ...base, id: 'discarded', discarded_at: 'x' },
          { ...base, id: 'erased', draft_answer_en: null },
        ],
        kb_entries: [{ id: 'e1', ...entry('approved') }],
      })
    );
    expect(await store.reviewRows(ACCOUNT)).toEqual([
      row('deleted', null),
      row('kept', entry('approved'), { distilled: true }),
    ]);
    expect(await store.distillState(ACCOUNT)).toEqual({
      enabled: false,
      lastDistilledAt: null,
    });
  });
});
