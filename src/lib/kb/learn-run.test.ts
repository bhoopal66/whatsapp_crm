import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => ({}) }));

import type { AiConfig } from '@/lib/ai/types';
import {
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
} from './learn-run';
import type { ThreadMessage } from './learn';

const ACCOUNT = 'acct-1';
/** With the account's names (none but the chats' own unless given). */
const learnTopic = (
  d: KbLearnDeps,
  accountId: string,
  config: AiConfig,
  topic: Parameters<typeof learnTopicWith>[3],
  names: string[] = []
) => learnTopicWith(d, accountId, config, topic, names);
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
      senderNames: { 'agent-user': 'Yusuf Ali' },
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
    openTopics: async () => [
      { id: 't1', label: 'Account without a trade licence?', coverage: 'none' },
    ],
    topicGapIds: async () => ['g1', 'g2'],
    topicDrafted: async () => false,
    gaps: async () => [gap('g1', 'c1'), gap('g2', 'c2')],
    thread: async (_a, conversationId) => threads[conversationId] ?? null,
    knownNames: async () => [],
    recordDiscard: async () => {},
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
      topicGapIds: async () => ['g0', 'g1', 'g2'],
      gaps: async () => [
        { ...gap('g0', 'hr'), question: 'salary certificate complaint' },
        gap('g1', 'c1'),
        gap('g2', 'c2'),
      ],
    });
    const d = deps(store);
    await learnTopic(d, ACCOUNT, CONFIG, {
      ...topic,
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
    expect(await learnAccount(d, ACCOUNT, 1e9)).toEqual({
      drafted: 0,
      tried: 0,
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
    expect(names).toHaveLength(1005);
    for (const n of [
      'Person 1000',
      'Last Page Co',
      'Yusuf Ali',
      'Case Co',
      'Bank Person',
    ])
      expect(names).toContain(n);
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
