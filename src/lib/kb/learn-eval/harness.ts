/**
 * Evaluation harness for "learn from team answers" (migrations 290, 318).
 * Test-only: no app code imports it (harness.test.ts checks).
 *
 * Runs a corpus of realistic chat cases (`corpus.ts`) through the real
 * pipeline (`learnTopic`: eligibility, answer picking, redaction, prompt,
 * output check, record) with an in-memory store and a SCRIPTED model, and
 * scores what happened. No network, no database, deterministic: it runs
 * in CI with the unit tests and fails the build on a regression.
 *
 * The scripted models are chosen to stress the pipeline, not to judge a
 * real model's prose:
 *   faithful        the case's general question and answer (happy path)
 *   echo            copies the whole prompt into its answer: the worst a
 *                   model can do with what it was sent
 *   echo-question   copies it into the question instead
 *   leaky           an answer with a phone number and an e-mail of its own
 *   leaky-question  the same in the question
 *   decline         nulls: the replies do not answer
 *
 * What is scored (`scoreCase`, `summarise`):
 *   leaks          a case secret found in anything sent to the model or in
 *                  the stored draft. Must be 0.
 *   idsSent        a database id (gap, chat, user, account) in the prompt.
 *                  Must be 0.
 *   outcome        drafted, or the reason it was not, as the case expects.
 *   picking        the team answers the model saw contain what the case
 *                  says they must, and none of what they must not.
 *   fence          every prompt fences the chat text exactly once, with
 *                  all of it inside the fence (the topic's label is not
 *                  sent at all).
 *   draftSafety    a stored draft is status-neutral text with no mask,
 *                  identifier or instruction echo.
 *   knownGapLeaks  secrets the pipeline is documented NOT to catch (a
 *                  name the workspace does not know). Reported, not
 *                  failed: the admin's review is the control there.
 */
import type { AiConfig, ChatMessage, GenerateResult } from '@/lib/ai/types';
import { echoesRedaction } from '@/lib/ai/redact-input';
import { brainRedact } from '@/lib/brain/redact';

import { buildNameMatcher, type KnownName } from '../known-names';
import {
  MAX_QUESTION_CHARS,
  isLearnableChat,
  type ThreadMessage,
} from '../learn';
import { MAX_NEW_SKILLS, type Skill } from '../skills';
import {
  evolveSkills,
  learnTopic,
  type KbLearnDeps,
  type KbLearnStore,
  type LearnGap,
  type LearnTopic,
  type RecordDraftArgs,
  type ReviewRow,
  type TopicOutcome,
} from '../learn-run';

export type ScriptedModel =
  | 'faithful'
  | 'echo'
  | 'echo-question'
  | 'leaky'
  | 'leaky-question'
  | 'decline';

/** One message in a case's chat, minutes after the customer's question. */
export interface CaseMessage {
  from: 'customer' | 'agent' | 'bot' | 'automation' | 'template';
  text: string;
  minutes: number;
  /** Which team member wrote it (agents only); default 'agent-1'. */
  agent?: string;
  /** A non-text message (image, document). */
  media?: boolean;
}

export interface CaseChat {
  question: string;
  contactName?: string;
  messages: CaseMessage[];
  personal?: boolean;
  optedOut?: boolean;
  doNotContact?: boolean;
  /** The gap carries no chat (the question came from elsewhere). */
  noConversation?: boolean;
}

export type ExpectedOutcome = 'drafted' | NonNullable<TopicOutcome['reason']>;

export interface EvalCase {
  id: string;
  /** What the case exercises (shown in the report, used for filtering). */
  tags: string[];
  note: string;
  topic: { label: string; coverage?: string };
  chats: CaseChat[];
  /** Team members' names, by agent key ('agent-1' has one by default: the
   *  run skips a reply whose sender it cannot name). */
  agents?: Record<string, string>;
  /** Other names the workspace knows (contacts, companies, cases…). */
  accountNames?: KnownName[];
  model: ScriptedModel;
  /** The general answer a faithful model gives (its question is
   *  MODEL_QUESTION). */
  modelAnswer?: { en: string; ar?: string };
  expect: {
    outcome: ExpectedOutcome;
    /** Each must appear in the team replies the model saw. */
    picked?: string[];
    /** None may appear anywhere the model saw. */
    notPicked?: string[];
    /** A draft must carry an Arabic answer. */
    arabic?: boolean;
  };
  /** Must never reach the model or the draft. */
  secrets: string[];
  /** Documented limits: reported when they get through, not failed. */
  knownGapSecrets?: string[];
  /** The workspace's active skill library (318). */
  skills?: Skill[];
  /** Skill titles that must / must not be in the draft prompt. */
  expectSkills?: { inPrompt?: string[]; notInPrompt?: string[] };
}

export interface CaseResult {
  id: string;
  tags: string[];
  outcome: string;
  expectedOutcome: string;
  outcomeOk: boolean;
  leaks: string[];
  knownGapLeaks: string[];
  idsSent: string[];
  pickingOk: boolean;
  pickingProblems: string[];
  fenceOk: boolean;
  draftSafetyOk: boolean;
  draftProblems: string[];
  modelCalls: number;
  /** What the model was sent (system + user), for the report's detail. */
  sent: string[];
  draft: RecordDraftArgs | null;
}

export interface EvalSummary {
  cases: number;
  passed: number;
  leaks: number;
  idsSent: number;
  outcomeAccuracy: number;
  pickingAccuracy: number;
  fenceIntegrity: number;
  draftSafety: number;
  knownGapLeaks: number;
  drafted: number;
  modelCalls: number;
  byTag: Record<string, { cases: number; passed: number }>;
  failures: { id: string; problems: string[] }[];
}

/** The bar CI holds the pipeline to. */
export const EVAL_THRESHOLDS = Object.freeze({
  leaks: 0,
  idsSent: 0,
  outcomeAccuracy: 1,
  pickingAccuracy: 1,
  fenceIntegrity: 1,
  draftSafety: 1,
});

const ACCOUNT = 'acct-eval-0001';
const GAP_AT = Date.parse('2026-11-10T10:00:00.000Z');
const iso = (minutes: number) =>
  new Date(GAP_AT + minutes * 60_000).toISOString();

/** The general question every scripted model but an echo or leak asks. */
const MODEL_QUESTION = 'What does the bank ask for?';
/** A name no case's text holds, so it changes nothing it is not meant to. */
const DEFAULT_AGENTS = { 'agent-1': 'Zaki Burhani' };

const CONFIG = {
  accountId: ACCOUNT,
  provider: 'openai',
  model: 'eval-standard',
  modelSmall: 'eval-small',
  apiKey: 'sk-eval',
} as unknown as AiConfig;

/** The ids the case's rows get: none may reach the model. */
function idsFor(c: EvalCase) {
  const chatIds = c.chats.map((_, i) => `conv-${c.id}-${i}`);
  const gapIds = c.chats.map((_, i) => `gap-${c.id}-${i}`);
  const agentIds = Object.keys({ ...DEFAULT_AGENTS, ...c.agents }).map(
    (k) => `user-${k}`
  );
  return { chatIds, gapIds, agentIds, topicId: `topic-${c.id}` };
}

function toThreadMessage(m: CaseMessage): ThreadMessage {
  const agentish = m.from === 'agent' || m.from === 'template';
  return {
    sender_type:
      m.from === 'customer' ? 'customer' : m.from === 'bot' ? 'bot' : 'agent',
    sender_id: agentish ? `user-${m.agent ?? 'agent-1'}` : null,
    content_type: m.media ? 'image' : 'text',
    content_text: m.text,
    template_name: m.from === 'template' ? 'eval_template' : null,
    created_at: iso(m.minutes),
    status: 'delivered',
  };
}

/** The case's topic, as `openTopics` hands it over. */
function topicOf(c: EvalCase): LearnTopic {
  const { topicId, gapIds } = idsFor(c);
  return {
    id: topicId,
    label: c.topic.label,
    coverage: c.topic.coverage ?? 'none',
    gapIds,
  };
}

/** The store, in memory, with the eligibility and window rules of
 *  `supabaseKbLearnStore` that a case can set. */
function memoryStore(c: EvalCase, drafts: RecordDraftArgs[]): KbLearnStore {
  const { chatIds, gapIds } = idsFor(c);
  const names: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...DEFAULT_AGENTS, ...c.agents }))
    names[`user-${k}`] = v;
  return {
    dueAccounts: async () => [ACCOUNT],
    claimRun: async () => true,
    finishRun: async () => {},
    askedThisWeek: async () => 0,
    openTopics: async () => [topicOf(c)],
    topicDrafted: async () => false,
    knownNames: async () => c.accountNames ?? [],
    recordDiscard: async () => {},
    noteLook: async () => {},
    gaps: async (_a, ids): Promise<LearnGap[]> =>
      c.chats
        .map((chat, i) => ({
          id: gapIds[i]!,
          conversation_id: chat.noConversation ? null : chatIds[i]!,
          question: chat.question,
          created_at: iso(0),
        }))
        .filter((g) => ids.includes(g.id)),
    thread: async (_a, conversationId, from, until) => {
      const i = chatIds.indexOf(conversationId);
      const chat = c.chats[i];
      if (!chat) return null;
      if (
        !isLearnableChat(
          { personal_owner_id: chat.personal ? 'user-owner' : null },
          {
            opted_out_at: chat.optedOut ? iso(-60) : null,
            do_not_contact_at: chat.doNotContact ? iso(-60) : null,
          }
        )
      )
        return null;
      const lo = Date.parse(from);
      const hi = Date.parse(until);
      const messages = chat.messages.map(toThreadMessage).filter((m) => {
        const at = Date.parse(m.created_at);
        return at > lo && at <= hi;
      });
      return {
        messages,
        contactName: chat.contactName ?? null,
        senderNames: names,
      };
    },
    recordDraft: async (args) => {
      drafts.push(args);
      return 'drafted';
    },
    activeSkills: async () => c.skills ?? [],
    skillTitles: async () =>
      (c.skills ?? []).map((s) => ({ title: s.title, status: 'active' })),
    reviewRows: async () => [],
    markReviewed: async () => {},
    distillState: async () => ({ enabled: true, lastDistilledAt: null }),
    addSkills: async () => 0,
  };
}

function userText(messages: ChatMessage[]): string {
  return messages.map((m) => m.content).join('\n');
}

/** The scripted model: what it answers, given what it was sent. */
function scriptedModel(c: EvalCase, sent: string[]) {
  return async (args: {
    systemPrompt: string;
    messages: ChatMessage[];
  }): Promise<GenerateResult> => {
    const user = userText(args.messages);
    sent.push(args.systemPrompt, user);
    const wantsAr = args.systemPrompt.includes('answer_ar');
    const LEAK =
      'Call our officer on +971 50 765 4321 or write to officer@bank.example.';
    let body: Record<string, unknown>;
    switch (c.model) {
      case 'faithful':
        body = {
          question: MODEL_QUESTION,
          answer_en: c.modelAnswer?.en ?? 'Yes. Please check the requirements.',
          ...(wantsAr ? { answer_ar: c.modelAnswer?.ar ?? 'نعم.' } : {}),
        };
        break;
      case 'echo':
        body = {
          question: MODEL_QUESTION,
          answer_en: user,
          ...(wantsAr ? { answer_ar: user } : {}),
        };
        break;
      case 'echo-question':
        // Short enough that only its content can have it refused.
        body = {
          question: user.slice(0, MAX_QUESTION_CHARS).trim(),
          answer_en: 'Yes.',
        };
        break;
      case 'leaky':
        body = { question: MODEL_QUESTION, answer_en: LEAK };
        break;
      case 'leaky-question':
        body = { question: LEAK, answer_en: 'Yes.' };
        break;
      case 'decline':
        body = { question: null, answer_en: null };
        break;
    }
    return {
      text: JSON.stringify(body),
      handoff: false,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  };
}

const EVIDENCE_OPEN = /<\s*evidence\b[^>]*>/giu;
const EVIDENCE_CLOSE = /<\/\s*evidence\b[^>]*>/giu;

/** Exactly one fence, and every chat text sent sits inside it. */
function fenceHolds(user: string): boolean {
  const opens = user.match(EVIDENCE_OPEN) ?? [];
  const closes = user.match(EVIDENCE_CLOSE) ?? [];
  if (opens.length !== 1 || closes.length !== 1) return false;
  const start = user.indexOf(opens[0]!);
  const end = user.indexOf(closes[0]!);
  if (start < 0 || end < start) return false;
  const outside = user.slice(0, start) + user.slice(end + closes[0]!.length);
  return outside.trim() === '';
}

/** The distil prompt: its fences once each, in order, and no other
 *  angle bracket, so nothing sent can open or close one. */
function distillFencesHold(user: string): boolean {
  const tags: string[] = user.match(/[<＜﹤][^>＞﹥]*[>＞﹥]?/gu) ?? [];
  const pair = (name: string) => [`<${name}>`, `</${name}>`];
  const expected = ['existing_rules', 'retired_rules', 'evidence']
    .filter((n) => n !== 'retired_rules' || tags.includes('<retired_rules>'))
    .flatMap(pair);
  return tags.join(' ') === expected.join(' ');
}

/** The team-replies part of the prompt. */
function repliesSection(user: string): string {
  const at = user.indexOf('Team replies:');
  return at < 0 ? '' : user.slice(at);
}

function draftProblems(d: RecordDraftArgs): string[] {
  const out: string[] = [];
  for (const [field, text] of [
    ['answer_en', d.answerEn],
    ['answer_ar', d.answerAr ?? ''],
    ['question', d.question],
  ] as const) {
    if (!text) continue;
    if (echoesRedaction(text) || /\[NAME\]|\[ID\]/.test(text))
      out.push(`${field} carries a mask`);
    const r = brainRedact(text);
    if (!r.ok || r.text !== text) out.push(`${field} carries an identifier`);
    if (/<\/?\s*evidence/i.test(text)) out.push(`${field} echoes the fence`);
  }
  if (!/^LRN-[A-Z0-9]{6,12}$/.test(d.ref)) out.push('bad ref');
  if (d.evidenceCount < 1) out.push('no evidence counted');
  return out;
}

const includesCI = (hay: string, needle: string) =>
  hay.toLowerCase().includes(needle.toLowerCase());

/** Runs one case and scores it. */
export async function runCase(c: EvalCase): Promise<CaseResult> {
  const sent: string[] = [];
  const drafts: RecordDraftArgs[] = [];
  let modelCalls = 0;
  const model = scriptedModel(c, sent);
  let seq = 0;
  const deps: KbLearnDeps = {
    store: memoryStore(c, drafts),
    loadConfig: async () => CONFIG,
    generate: (async (args: Parameters<KbLearnDeps['generate']>[0]) => {
      modelCalls++;
      return model(args);
    }) as KbLearnDeps['generate'],
    logUsage: async () => {},
    now: () => GAP_AT,
    // Deterministic refs: same corpus, same report.
    random: () => (seq = (seq * 9301 + 49297) % 233280) / 233280,
  };
  const outcome = await learnTopic(
    deps,
    ACCOUNT,
    CONFIG,
    topicOf(c),
    await deps.store.knownNames(ACCOUNT),
    undefined,
    await deps.store.activeSkills(ACCOUNT)
  );
  const got: string = outcome.drafted ? 'drafted' : (outcome.reason ?? '?');
  const draft = drafts[0] ?? null;
  const everythingSent = sent.join('\n');
  const stored = draft
    ? [draft.question, draft.answerEn, draft.answerAr ?? '', draft.notes].join(
        '\n'
      )
    : '';
  const exposed = `${everythingSent}\n${stored}`;

  const leaks = c.secrets.filter((s) => includesCI(exposed, s));
  const knownGapLeaks = (c.knownGapSecrets ?? []).filter((s) =>
    includesCI(exposed, s)
  );
  const ids = idsFor(c);
  const idsSent = [
    ...ids.chatIds,
    ...ids.gapIds,
    ...ids.agentIds,
    ids.topicId,
    ACCOUNT,
  ].filter((id) => everythingSent.includes(id));

  const pickingProblems: string[] = [];
  const user = sent[1] ?? '';
  const replies = repliesSection(user);
  for (const p of c.expect.picked ?? [])
    if (!includesCI(replies, p)) pickingProblems.push(`missing "${p}"`);
  for (const p of c.expect.notPicked ?? [])
    if (includesCI(everythingSent, p)) pickingProblems.push(`sent "${p}"`);
  const system = sent[0] ?? '';
  for (const t of c.expectSkills?.inPrompt ?? [])
    if (!system.includes(t)) pickingProblems.push(`skill missing "${t}"`);
  for (const t of c.expectSkills?.notInPrompt ?? [])
    if (system.includes(t)) pickingProblems.push(`skill sent "${t}"`);

  const fenceOk = modelCalls === 0 || fenceHolds(user);
  const problems = draft ? draftProblems(draft) : [];
  if (draft && c.expect.arabic && !draft.answerAr)
    problems.push('no Arabic answer');

  return {
    id: c.id,
    tags: c.tags,
    outcome: got,
    expectedOutcome: c.expect.outcome,
    outcomeOk: got === c.expect.outcome,
    leaks,
    knownGapLeaks,
    idsSent,
    pickingOk: pickingProblems.length === 0,
    pickingProblems,
    fenceOk,
    draftSafetyOk: problems.length === 0,
    draftProblems: problems,
    modelCalls,
    sent,
    draft,
  };
}

/** A case passes when nothing leaked and every score holds. */
export function casePassed(r: CaseResult): boolean {
  return (
    r.leaks.length === 0 &&
    r.idsSent.length === 0 &&
    r.outcomeOk &&
    r.pickingOk &&
    r.fenceOk &&
    r.draftSafetyOk
  );
}

function problemsOf(r: CaseResult): string[] {
  const out: string[] = [];
  if (!r.outcomeOk)
    out.push(`outcome ${r.outcome}, expected ${r.expectedOutcome}`);
  for (const l of r.leaks) out.push(`LEAK "${l}"`);
  for (const id of r.idsSent) out.push(`id sent: ${id}`);
  out.push(...r.pickingProblems.map((p) => `picking: ${p}`));
  if (!r.fenceOk) out.push('evidence fence broken');
  out.push(...r.draftProblems.map((p) => `draft: ${p}`));
  return out;
}

const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);

export function summarise(results: CaseResult[]): EvalSummary {
  const byTag: EvalSummary['byTag'] = {};
  for (const r of results)
    for (const t of r.tags) {
      byTag[t] ??= { cases: 0, passed: 0 };
      byTag[t].cases++;
      if (casePassed(r)) byTag[t].passed++;
    }
  const withPicking = results.filter((r) => r.modelCalls > 0);
  return {
    cases: results.length,
    passed: results.filter(casePassed).length,
    leaks: results.reduce((n, r) => n + r.leaks.length, 0),
    idsSent: results.reduce((n, r) => n + r.idsSent.length, 0),
    outcomeAccuracy: ratio(
      results.filter((r) => r.outcomeOk).length,
      results.length
    ),
    pickingAccuracy: ratio(
      results.filter((r) => r.pickingOk).length,
      results.length
    ),
    fenceIntegrity: ratio(
      withPicking.filter((r) => r.fenceOk).length,
      withPicking.length
    ),
    draftSafety: ratio(
      results.filter((r) => r.draft && r.draftSafetyOk).length,
      results.filter((r) => r.draft).length
    ),
    knownGapLeaks: results.reduce((n, r) => n + r.knownGapLeaks.length, 0),
    drafted: results.filter((r) => r.draft).length,
    modelCalls: results.reduce((n, r) => n + r.modelCalls, 0),
    byTag,
    failures: results
      .filter((r) => !casePassed(r))
      .map((r) => ({ id: r.id, problems: problemsOf(r) })),
  };
}

/** Which thresholds the summary misses (empty = the bar holds). */
export function thresholdBreaches(s: EvalSummary): string[] {
  const t = EVAL_THRESHOLDS;
  const out: string[] = [];
  if (s.leaks > t.leaks) out.push(`leaks ${s.leaks} > ${t.leaks}`);
  if (s.idsSent > t.idsSent) out.push(`ids sent ${s.idsSent} > ${t.idsSent}`);
  for (const k of [
    'outcomeAccuracy',
    'pickingAccuracy',
    'fenceIntegrity',
    'draftSafety',
  ] as const)
    if (s[k] < t[k]) out.push(`${k} ${pct(s[k])} < ${pct(t[k])}`);
  return out;
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** The report as Markdown (written when KB_LEARN_EVAL_REPORT is set). */
export function formatReport(s: EvalSummary, results: CaseResult[]): string {
  const lines = [
    '# Learn from team answers: evaluation',
    '',
    `Cases: ${s.cases}, passed: ${s.passed}, drafted: ${s.drafted}, model calls: ${s.modelCalls}`,
    '',
    '| Score | Value | Bar |',
    '| --- | --- | --- |',
    `| Leaks (secrets sent or stored) | ${s.leaks} | ${EVAL_THRESHOLDS.leaks} |`,
    `| Database ids sent | ${s.idsSent} | ${EVAL_THRESHOLDS.idsSent} |`,
    `| Outcome accuracy | ${pct(s.outcomeAccuracy)} | ${pct(EVAL_THRESHOLDS.outcomeAccuracy)} |`,
    `| Answer picking | ${pct(s.pickingAccuracy)} | ${pct(EVAL_THRESHOLDS.pickingAccuracy)} |`,
    `| Evidence fence | ${pct(s.fenceIntegrity)} | ${pct(EVAL_THRESHOLDS.fenceIntegrity)} |`,
    `| Draft safety | ${pct(s.draftSafety)} | ${pct(EVAL_THRESHOLDS.draftSafety)} |`,
    `| Known-gap leaks (reported only) | ${s.knownGapLeaks} | n/a |`,
    '',
    '## By tag',
    '',
    '| Tag | Passed |',
    '| --- | --- |',
    ...Object.entries(s.byTag)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([t, v]) => `| ${t} | ${v.passed}/${v.cases} |`),
    '',
    '## Cases',
    '',
    '| Case | Tags | Outcome | Result |',
    '| --- | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.tags.join(', ')} | ${r.outcome} | ${casePassed(r) ? 'pass' : `FAIL: ${problemsOf(r).join('; ')}`}${r.knownGapLeaks.length ? ` (known gap: ${r.knownGapLeaks.length})` : ''} |`
    ),
    '',
  ];
  return lines.join('\n');
}

export async function runEval(
  corpus: readonly EvalCase[]
): Promise<{ summary: EvalSummary; results: CaseResult[] }> {
  const results: CaseResult[] = [];
  for (const c of corpus) results.push(await runCase(c));
  return { summary: summarise(results), results };
}

// ---------------------------------------------------------------------
// The skill library (318): the evolution cycle under the same bar.
// ---------------------------------------------------------------------

export interface DistillReview {
  /** The entry's question (there is none once the draft was deleted). */
  topic: string;
  draft: string;
  /** The entry now: null = deleted. */
  entry: { status: string; answer_en: string } | null;
  /** Already classified / distilled in an earlier run. */
  outcome?: 'approved' | 'edited' | 'removed' | 'deleted';
  distilled?: boolean;
}

export interface DistillCase {
  id: string;
  tags: string[];
  note: string;
  reviews: DistillReview[];
  /** The names the workspace knows. */
  accountNames?: KnownName[];
  /** What the model proposes ('echo' copies its prompt into a skill). */
  model: 'propose' | 'echo' | 'leaky';
  proposed?: {
    kind: string;
    category?: string;
    title: string;
    principle: string;
  }[];
  expect: { evolved: boolean; added: number; reason?: string | null };
  secrets: string[];
}

export interface DistillResult {
  id: string;
  tags: string[];
  ok: boolean;
  problems: string[];
  leaks: string[];
}

export async function runDistillCase(c: DistillCase): Promise<DistillResult> {
  const sent: string[] = [];
  const stored: Skill[] = [];
  const rows: ReviewRow[] = c.reviews.map((r, i) => ({
    id: `review-${c.id}-${i}`,
    draftAnswer: r.draft,
    outcome: r.outcome ?? null,
    distilled: r.distilled ?? false,
    entry: r.entry && { ...r.entry, question: r.topic },
  }));
  const store: KbLearnStore = {
    ...memoryStore(
      {
        id: c.id,
        tags: [],
        note: '',
        topic: { label: 'x' },
        chats: [],
        model: 'faithful',
        expect: { outcome: 'no_answers' },
        secrets: [],
      },
      []
    ),
    reviewRows: async () => rows,
    addSkills: async (_a, skills) => {
      const added = skills.slice(0, MAX_NEW_SKILLS);
      stored.push(...added);
      return added.length;
    },
  };
  const deps: KbLearnDeps = {
    store,
    loadConfig: async () => CONFIG,
    generate: (async (args: {
      systemPrompt: string;
      messages: ChatMessage[];
    }) => {
      const user = userText(args.messages);
      sent.push(args.systemPrompt, user);
      const skills =
        c.model === 'echo'
          ? [{ kind: 'general', title: 'Echo', principle: user.slice(0, 500) }]
          : c.model === 'leaky'
            ? [
                {
                  kind: 'general',
                  title: 'Contact',
                  principle: 'Tell customers to call +971 50 765 4321.',
                },
              ]
            : (c.proposed ?? []);
      return {
        text: JSON.stringify({ skills }),
        handoff: false,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    }) as KbLearnDeps['generate'],
    logUsage: async () => {},
    now: () => GAP_AT,
  };
  const res = await evolveSkills(
    deps,
    ACCOUNT,
    CONFIG,
    buildNameMatcher(c.accountNames ?? []),
    GAP_AT + 60_000
  );
  const problems: string[] = [];
  if (res.evolved !== c.expect.evolved)
    problems.push(`evolved ${res.evolved}, expected ${c.expect.evolved}`);
  if (res.added !== c.expect.added)
    problems.push(`added ${res.added}, expected ${c.expect.added}`);
  if (c.expect.reason !== undefined && res.reason !== c.expect.reason)
    problems.push(`reason ${res.reason}, expected ${c.expect.reason}`);
  const storedText = stored
    .map((s) => `${s.title} ${s.principle} ${s.whenToApply ?? ''}`)
    .join('\n');
  const leaks = c.secrets.filter((s) =>
    includesCI(`${sent.join('\n')}\n${storedText}`, s)
  );
  for (const l of leaks) problems.push(`LEAK "${l}"`);
  for (const s of stored) {
    const text = `${s.title} ${s.principle} ${s.whenToApply ?? ''}`;
    const r = brainRedact(text);
    if (
      !r.ok ||
      r.text !== text ||
      echoesRedaction(text) ||
      /@|<\/?\s*evidence/i.test(text)
    )
      problems.push(`unsafe skill "${s.title}"`);
  }
  if (sent[1] && !distillFencesHold(sent[1]))
    problems.push('evidence fence broken');
  return { id: c.id, tags: c.tags, ok: problems.length === 0, problems, leaks };
}
