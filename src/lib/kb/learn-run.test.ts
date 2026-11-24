import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => ({}) }));

import type { AiConfig } from '@/lib/ai/types';
import type { Skill } from './skills';
import {
  evolveSkills,
  learnAccount,
  learnTopic,
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
  finished: [string, number][];
} {
  const recorded: RecordDraftArgs[] = [];
  const finished: [string, number][] = [];
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
      senderNames: {},
    },
  };
  return {
    recorded,
    finished,
    dueAccounts: async () => [ACCOUNT],
    claimRun: async () => true,
    finishRun: async (id, n) => {
      finished.push([id, n]);
    },
    activeSkills: async () => [],
    skillTitles: async () => [],
    reviewRows: async () => [],
    markReviewed: async () => {},
    addSkills: async () => 0,
    openTopics: async () => [
      { id: 't1', label: 'Account without a trade licence?', coverage: 'none' },
    ],
    topicGapIds: async () => ['g1', 'g2'],
    topicDrafted: async () => false,
    gaps: async () => [gap('g1', 'c1'), gap('g2', 'c2')],
    thread: async (_a, conversationId) => threads[conversationId] ?? null,
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
        text: '{"answer_en":"Yes. A freelance permit can stand in for a trade licence."}',
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
    expect(r.question).toBe('Account without a trade licence?');
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
              senderNames: {},
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
          senderNames: {},
        },
        c2: {
          messages: [reply('نعم، تكفي رخصة العمل الحر')],
          contactName: null,
          senderNames: {},
        },
      },
    });
    const d = deps(store, {
      generate: vi.fn(async () => ({
        text: '{"answer_en":"Yes, with a freelance permit.","answer_ar":"نعم، برخصة عمل حر."}',
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
        text: '{"answer_en":"Ask [NAME] on +971 50 123 4567."}',
        handoff: false,
        usage: null,
      })),
    });
    const out = await learnTopic(d, ACCOUNT, CONFIG, {
      id: 't1',
      label: 'x',
      coverage: 'none',
    });
    expect(out).toEqual({ drafted: false, reason: 'unusable' });
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
          senderNames: {},
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

describe('learnAccount', () => {
  it('needs an AI key', async () => {
    const store = fakeStore();
    const d = deps(store, { loadConfig: async () => null });
    expect(await learnAccount(d, ACCOUNT, 1e9)).toEqual({
      drafted: 0,
      tried: 0,
    });
    expect(d.generate).not.toHaveBeenCalled();
  });

  it('caps topics per run at ten', async () => {
    const store = fakeStore({
      openTopics: async () =>
        Array.from({ length: 15 }, (_, k) => ({
          id: `t${k}`,
          label: `topic ${k}`,
          coverage: 'none',
        })),
    });
    const d = deps(store);
    expect(await learnAccount(d, ACCOUNT, 1e9)).toEqual({
      drafted: 10,
      tried: 10,
    });
  });

  it('starts no topic after its time budget', async () => {
    const store = fakeStore();
    const d = deps(store);
    expect(await learnAccount(d, ACCOUNT, TOPIC_MIN_BUDGET_MS - 1)).toEqual({
      drafted: 0,
      tried: 0,
    });
  });

  it('never throws', async () => {
    const store = fakeStore({
      openTopics: async () => {
        throw new Error('db down');
      },
    });
    await expect(learnAccount(deps(store), ACCOUNT, 1e9)).resolves.toEqual({
      drafted: 0,
      tried: 0,
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
    expect(store.finished).toEqual([['b', 1]]);
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

describe('evolveSkills (the skill library)', () => {
  const row = (
    id: string,
    entry: { status: string; answer_en: string } | null,
    over: Partial<ReviewRow> = {}
  ): ReviewRow => ({
    id,
    topicLabel: 'Account without a trade licence?',
    draftAnswer: 'A freelance permit works instead of a trade licence.',
    outcome: null,
    distilled: false,
    entry,
    ...over,
  });
  const approved = {
    status: 'approved',
    answer_en: 'A freelance permit works instead of a trade licence.',
  };

  function skillStore(rows: ReviewRow[]) {
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
    });
    return { store, marked, added };
  }
  const skillModel = (skills: unknown[]) =>
    vi.fn(
      async (args: {
        systemPrompt: string;
        messages: { content: string }[];
      }) => {
        void args;
        return {
          text: JSON.stringify({ skills }),
          handoff: false,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      }
    );

  it('classifies reviews and waits for enough of them', async () => {
    const { store, marked, added } = skillStore([
      row('r1', approved),
      row('r2', { status: 'draft', answer_en: '' }),
      row('r3', null),
    ]);
    const d = deps(store);
    const res = await evolveSkills(d, ACCOUNT, CONFIG, 1e9);
    expect(marked).toEqual([
      { id: 'r1', outcome: 'approved' },
      { id: 'r3', outcome: 'deleted' },
    ]);
    expect(res).toMatchObject({ classified: 2, evolved: false, added: 0 });
    expect(d.generate).not.toHaveBeenCalled();
    expect(added).toHaveLength(0);
  });

  it('evolves on a low approval rate, sends only redacted examples, adds safe skills', async () => {
    const leaky = 'Call +971 50 123 4567 or write to sara.ali@example.com';
    const { store, added } = skillStore([
      row('r1', null, { draftAnswer: `Sara Ali said: ${leaky}` }),
      row('r2', { status: 'remove', answer_en: 'x' }),
      row('r3', { status: 'remove', answer_en: 'x' }),
      row('r4', { status: 'remove', answer_en: 'x' }),
      row('r5', approved, { outcome: 'approved', distilled: true }),
    ]);
    const generate = skillModel([
      {
        kind: 'mistake',
        title: 'Promising approval',
        principle: 'Do not promise approval; the bank decides.',
      },
      { kind: 'general', title: 'Leaky', principle: 'Call +971 50 123 4567.' },
    ]);
    const d = deps(store, {
      generate: generate as unknown as KbLearnDeps['generate'],
    });
    const res = await evolveSkills(d, ACCOUNT, CONFIG, 1e9);
    expect(res).toMatchObject({
      evolved: true,
      reason: 'low_approval',
      added: 1,
    });
    const sent = generate.mock.calls
      .map(
        ([a]) => a.systemPrompt + a.messages.map((m) => m.content).join('\n')
      )
      .join('\n');
    for (const s of ['+971 50 123 4567', 'sara.ali@example.com'])
      expect(sent).not.toContain(s);
    expect(added[0]!.skills.map((s) => s.title)).toEqual([
      'Promising approval',
    ]);
    // Only the not-yet-distilled reviews are marked distilled.
    expect(added[0]!.reviewIds).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(d.logUsage).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'kb_learn' })
    );
  });

  it('does not start the model call without time left', async () => {
    const { store } = skillStore(
      ['a', 'b', 'c', 'd', 'e'].map((id) => row(id, approved))
    );
    const d = deps(store);
    const res = await evolveSkills(d, ACCOUNT, CONFIG, TOPIC_MIN_BUDGET_MS - 1);
    expect(res.evolved).toBe(false);
    expect(d.generate).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const store = fakeStore({
      reviewRows: async () => {
        throw new Error('db down');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      evolveSkills(deps(store), ACCOUNT, CONFIG, 1e9)
    ).resolves.toMatchObject({
      evolved: false,
    });
    warn.mockRestore();
  });

  it('puts the relevant learned skills in the draft prompt', async () => {
    const store = fakeStore({
      activeSkills: async () => [
        {
          kind: 'general',
          category: null,
          title: 'Name the documents',
          principle: 'List what to bring.',
          whenToApply: null,
          evidenceCount: 3,
        },
        {
          kind: 'category',
          category: 'pos',
          title: 'POS only rule',
          principle: 'x',
          whenToApply: null,
          evidenceCount: 1,
        },
      ],
    });
    const d = deps(store);
    await learnAccount(d, ACCOUNT, 1e9);
    const system = d.sent[0]!;
    expect(system).toContain('House rules');
    expect(system).toContain('Name the documents');
    expect(system).not.toContain('POS only rule');
  });
});
