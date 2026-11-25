/**
 * Learn from team answers (migration 290): the weekly cron job.
 *
 * For each workspace with the switch on that is due (kb_learn_claim_run
 * stamps it first, so two crons never both run), up to
 * MAX_TOPICS_PER_RUN open gap topics a week without a live learned draft:
 * collect up to five team answers and the customer questions from sales
 * chats only, mask them with the account's whole name list (read once per
 * run; fail closed: a list or chat that cannot be read, or a text that
 * cannot be screened, sends nothing), ask the workspace's own AI key
 * (model_small if set) for one general question and answer, screen both
 * with the same list, and store them through kb_learn_record_draft, which writes a
 * kb_entries DRAFT only. The bot's reply path and approved-answer
 * selection are untouched: a draft is never shortlisted.
 *
 * The model call goes through `generateReply`, which runs
 * `assertAiTransfer` (224) with purpose 'kb_learn' before anything is
 * sent, and masks identifiers again. Usage is logged as mode 'kb_learn'.
 *
 * Only a run that finished starts the week's wait. One that could not
 * (no AI key, a failed read, the model failing, out of time, or a crash)
 * is tried again within the hour, at most three times in 24 hours, and
 * the switch says why. The topics asked in the last 7 days (the ledger:
 * drafted, discarded, backed off) count toward the ten, so the retries
 * never ask about more than ten topics a week.
 *
 * Before drafting, the run learns from how admins reviewed the earlier
 * drafts (318, skills.ts): `evolveSkills` distils at most three short
 * rules a week, and each draft's prompt gets the ones that fit its topic.
 *
 * Server-only, service role. Never throws; starts no new account or topic
 * after its time budget.
 */
import { createHmac } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/ai/admin-client';
import { loadAiConfig } from '@/lib/ai/config';
import { generateReply } from '@/lib/ai/generate';
import { AiError, type AiConfig } from '@/lib/ai/types';
import { notSalesChat } from '@/lib/ai/not-sales-chat';
import { logAiUsage, type LogAiUsageArgs } from '@/lib/ai/usage';

import {
  ANSWER_WINDOW_MS,
  BURST_GAP_MS,
  KB_LEARN_INTERVAL_DAYS,
  MAX_ANSWERS_PER_TOPIC,
  MIN_ANSWERS_PER_TOPIC,
  MAX_TOPICS_PER_RUN,
  buildLearnPrompt,
  isLearnableChat,
  learnedRef,
  learnedReviewerNotes,
  parseLearnedAnswer,
  pickTeamAnswer,
  redactEvidence,
  redactEvidenceText,
  wantsArabic,
  type LearnPrompt,
  type ThreadMessage,
} from './learn';
import type { KbLearnRunError } from './learn-settings';
import {
  buildNameMatcher,
  type KnownName,
  type NameMatcher,
} from './known-names';
import {
  MAX_ACTIVE_SKILLS,
  buildDistillPrompt,
  classifyReview,
  evolveDecision,
  isSkillCategory,
  parseSkillUpdate,
  prepareExamples,
  renderSkills,
  safeSkills,
  selectSkills,
  type EvolveReason,
  type ReviewOutcome,
  type Skill,
  type SkillKind,
} from './skills';

/** The cron pass starts no new account after this long. */
export const PASS_BUDGET_MS = 45_000;
/** No topic is started with less than this left (a model call). */
export const TOPIC_MIN_BUDGET_MS = 15_000;
/** Accounts looked at per pass. */
export const MAX_ACCOUNTS_PER_PASS = 20;
/** The run stops after this many model failures in a row. */
export const MAX_MODEL_FAILURES = 3;
/** The skill library is asked about only with this much left: a topic
 *  still fits after it. */
export const EVOLVE_MIN_BUDGET_MS = 2 * TOPIC_MIN_BUDGET_MS;
/** …and not again this soon after the last time (a day short of the
 *  weekly run, so that one is never missed by seconds). */
export const EVOLVE_INTERVAL_MS = (KB_LEARN_INTERVAL_DAYS - 1) * 86_400_000;
/** Gaps of a topic read to find answers. */
const MAX_GAPS_READ = 25;
/** Topics read per account. The query already leaves out the covered,
 *  drafted and backed-off ones; those without team answers cost no
 *  model call, so many may be looked at. */
const MAX_TOPICS_READ = 200;

export interface LearnTopic {
  id: string;
  label: string;
  coverage: string;
  /** Every gap of the topic, newest first. */
  gapIds: string[];
}

export interface LearnGap {
  id: string;
  conversation_id: string | null;
  question: string;
  created_at: string;
}

/** One chat's messages after a gap, when the chat may be learned from. */
export interface LearnThread {
  messages: ThreadMessage[];
  /** The customer's name, masked out of the answer. */
  contactName: string | null;
  /** auth user id → the team member's name, masked out too. */
  senderNames: Record<string, string>;
  /** The customer's messages the gap is about (messages.id). */
  questionIds?: string[];
}

export type RecordDraftResult =
  'drafted' | 'disabled' | 'already' | 'invalid' | 'ref_taken' | 'error';

export interface RecordDraftArgs {
  accountId: string;
  topicId: string;
  /** A hash of the topic's label; the label itself is never stored. */
  topicKey: string;
  gapIds: string[];
  ref: string;
  question: string;
  answerEn: string;
  answerAr: string | null;
  notes: string;
  evidenceCount: number;
}

/** The database, as the job uses it (a port so the job is testable). */
export interface KbLearnStore {
  /** The accounts due now, the longest due first. */
  dueAccounts(now: Date): Promise<string[]>;
  claimRun(accountId: string): Promise<boolean>;
  /** Records how many drafts the run wrote and why it failed, if it did
   *  (the switch shows both). No error starts the 7-day wait. */
  finishRun(
    accountId: string,
    drafted: number,
    error: KbLearnRunError | null
  ): Promise<void>;
  /** Topics asked in the last 7 days: the ledger's rows. */
  askedThisWeek(accountId: string): Promise<number>;
  openTopics(accountId: string): Promise<LearnTopic[]>;
  topicDrafted(
    accountId: string,
    gapIds: string[],
    topicKey: string
  ): Promise<boolean>;
  /** Every person and company name known to the account. Throws when any
   *  part of it cannot be read. */
  knownNames(accountId: string): Promise<KnownName[]>;
  /** Notes that the model's text was thrown away, or that it declined,
   *  so the topic is not asked again for 28 days. */
  recordDiscard(
    args: Pick<
      RecordDraftArgs,
      'accountId' | 'topicId' | 'topicKey' | 'gapIds' | 'evidenceCount'
    >
  ): Promise<void>;
  /** Notes that a topic was looked at and what came of it, so busy topics
   *  without answers wait behind the rest and one that failed at the
   *  model three times backs off. */
  noteLook(
    accountId: string,
    gapIds: string[],
    modelFailed: boolean
  ): Promise<void>;
  gaps(accountId: string, ids: string[]): Promise<LearnGap[]>;
  thread(
    accountId: string,
    conversationId: string,
    from: string,
    until: string
  ): Promise<LearnThread | null>;
  recordDraft(args: RecordDraftArgs): Promise<RecordDraftResult>;
  /** The skill library (318): the active skills. */
  activeSkills(accountId: string): Promise<Skill[]>;
  /** Every skill's kind and title, retired ones included (what an admin
   *  retired is not added again). */
  skillTitles(accountId: string): Promise<{ kind: SkillKind; title: string }[]>;
  /** The latest drafts, newest first, each with its entry as it is now. */
  reviewRows(accountId: string): Promise<ReviewRow[]>;
  /** Stamps the outcome of rows not classified yet. */
  markReviewed(
    accountId: string,
    rows: { id: string; outcome: ReviewOutcome }[]
  ): Promise<void>;
  /** Whether the switch is still on, and when the library last learned. */
  distillState(
    accountId: string
  ): Promise<{ enabled: boolean; lastDistilledAt: string | null }>;
  /** kb_learn_add_skills: adds up to three, marks the reviews distilled. */
  addSkills(
    accountId: string,
    skills: Skill[],
    reviewIds: string[]
  ): Promise<number>;
}

/** One kb_learned_drafts row and its entry, for the skill library. */
export interface ReviewRow {
  id: string;
  /** Null once erased (or from before 318): then not a review at all. */
  draftAnswer: string | null;
  outcome: ReviewOutcome | null;
  distilled: boolean;
  /** Null: the draft was deleted. */
  entry: { status: string; question: string; answer_en: string } | null;
}

export interface KbLearnDeps {
  store: KbLearnStore;
  loadConfig: (accountId: string) => Promise<AiConfig | null>;
  generate: typeof generateReply;
  logUsage: (args: LogAiUsageArgs) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface TopicOutcome {
  drafted: boolean;
  reason?:
    | 'covered'
    | 'already'
    | 'no_answers'
    | 'redaction'
    | 'model'
    | 'unusable'
    /** The model's text carried a name, an identifier or a mask. */
    | 'discarded'
    | 'refused'
    /** Asked, but the ledger could not note it: stop the account, or the
     *  weekly count would not see the topic. */
    | 'unrecorded'
    /** The switch went off while the run worked: stop the account. */
    | 'disabled';
}

/** Outcomes after which the model had been asked. */
const ASKED = new Set([
  'model',
  'unusable',
  'discarded',
  'refused',
  'unrecorded',
]);

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * The ledger's key for a topic whose gaps changed on a recompute: an HMAC
 * with the app's secret, which the database does not hold, because the
 * label is a customer's own message. Per account, so equal
 * labels in two workspaces do not match.
 */
export function topicKey(accountId: string, label: string): string {
  const norm = String(label ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const secret = process.env.ENCRYPTION_KEY;
  // Fail closed: without the secret the key could be guessed from a label.
  if (!secret) throw new Error('topicKey: ENCRYPTION_KEY is not set');
  return createHmac('sha256', `kb-learn:${secret}`)
    .update(`${accountId}\n${norm}`)
    .digest('hex');
}

/**
 * The one model call. generateReply runs assertAiTransfer (purpose
 * 'kb_learn') first; a call the provider answered is logged, a failed one
 * (cut off, empty) included, as it was billed all the same.
 */
async function askModel(
  deps: KbLearnDeps,
  accountId: string,
  config: AiConfig,
  prompt: LearnPrompt
): Promise<{ text: string } | 'unusable' | 'model'> {
  const model = config.modelSmall || config.model;
  const logUsage = (usage: LogAiUsageArgs['usage']) =>
    deps.logUsage({
      accountId,
      conversationId: null,
      mode: 'kb_learn',
      provider: config.provider,
      model,
      usage,
    });
  try {
    const result = await deps.generate({
      config,
      systemPrompt: prompt.systemPrompt,
      messages: [{ role: 'user', content: prompt.userMessage }],
      model,
      purpose: 'kb_learn',
    });
    await logUsage(result.usage);
    return { text: result.text };
  } catch (err) {
    console.warn(
      `[kb-learn] model call failed for account ${accountId}: ${message(err)}`
    );
    if (err instanceof AiError && err.usage) await logUsage(err.usage);
    return err instanceof AiError &&
      (err.code === 'truncated' || err.code === 'empty_response')
      ? 'unusable'
      : 'model';
  }
}

/**
 * One topic. Exported for the tests: the redaction gate, the evidence
 * and what reaches the model are asserted here.
 */
export async function learnTopic(
  deps: KbLearnDeps,
  accountId: string,
  config: AiConfig,
  topic: LearnTopic,
  accountNames: readonly KnownName[],
  accountMatcher: NameMatcher = buildNameMatcher(accountNames),
  skills: readonly Skill[] = []
): Promise<TopicOutcome> {
  const { store } = deps;
  // An approved answer already covers it (152's judgment): nothing to learn.
  if (topic.coverage === 'full' || topic.coverage === 'partial')
    return { drafted: false, reason: 'covered' };
  const key = topicKey(accountId, topic.label);
  const { gapIds } = topic;
  if (gapIds.length === 0) return { drafted: false, reason: 'no_answers' };
  if (await store.topicDrafted(accountId, gapIds, key))
    return { drafted: false, reason: 'already' };

  const gaps = (await store.gaps(accountId, gapIds.slice(0, MAX_GAPS_READ)))
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const answers: { text: string; at: string }[] = [];
  // Only questions from chats that may be learned from (a sales chat, not
  // personal, not opted out). The topic's label is not one of them: it may
  // come from any chat.
  const questions: string[] = [];
  const chatNames = new Set<string>();
  const seenChats = new Set<string>();
  for (const gap of gaps) {
    if (answers.length >= MAX_ANSWERS_PER_TOPIC) break;
    if (!gap.conversation_id || seenChats.has(gap.conversation_id)) continue;
    seenChats.add(gap.conversation_id);
    const at = Date.parse(gap.created_at);
    if (!Number.isFinite(at)) continue;
    const thread = await store.thread(
      accountId,
      gap.conversation_id,
      gap.created_at,
      new Date(at + ANSWER_WINDOW_MS).toISOString()
    );
    if (!thread) continue;
    const reply = pickTeamAnswer(
      gap.created_at,
      thread.messages,
      thread.questionIds
    );
    if (!reply?.content_text) continue;
    // A sender whose name is unknown cannot be masked out of a reply.
    const senderName = reply.sender_id
      ? thread.senderNames[reply.sender_id]?.trim()
      : '';
    if (!senderName) continue;
    for (const n of [thread.contactName, ...Object.values(thread.senderNames)])
      if (n) chatNames.add(n);
    questions.push(gap.question);
    answers.push({ text: reply.content_text, at: reply.created_at });
  }
  if (answers.length < MIN_ANSWERS_PER_TOPIC)
    return { drafted: false, reason: 'no_answers' };

  // The account's whole list masks every text, then the chats' own names
  // (a contact saved since the list was read). Fail closed: nothing goes
  // out unless every text was screened.
  const chatMatcher = buildNameMatcher(chatNames);
  const matcher: NameMatcher = {
    mask: (t) => chatMatcher.mask(accountMatcher.mask(t)),
  };
  const redacted = redactEvidence(
    { questions, answers: answers.map((a) => a.text) },
    (t) => redactEvidenceText(t, matcher)
  );
  if (!redacted.ok) return { drafted: false, reason: 'redaction' };
  const { evidence } = redacted;
  if (
    evidence.answers.length < MIN_ANSWERS_PER_TOPIC ||
    evidence.questions.length === 0
  )
    return { drafted: false, reason: 'no_answers' };
  const arabic = wantsArabic(evidence.answers);
  const prompt = buildLearnPrompt({
    questions: evidence.questions,
    answers: evidence.answers,
    arabic,
    // The label only picks the rules, here; it is never sent. Screened
    // again: a name can become known after a rule was stored.
    houseRules: renderSkills(
      selectSkills(safeSkills(skills, matcher), topic.label)
    ),
  });
  const backOff = async (
    reason: 'unusable' | 'discarded' | 'refused'
  ): Promise<TopicOutcome> => {
    try {
      await store.recordDiscard({
        accountId,
        topicId: topic.id,
        topicKey: key,
        gapIds,
        evidenceCount: evidence.answers.length,
      });
      return { drafted: false, reason };
    } catch (err) {
      console.warn(
        `[kb-learn] a topic was not noted for account ${accountId}: ${message(err)}`
      );
      return { drafted: false, reason: 'unrecorded' };
    }
  };
  const asked = await askModel(deps, accountId, config, prompt);
  if (asked === 'unusable') return backOff('unusable');
  if (asked === 'model') return { drafted: false, reason: 'model' };
  const answer = parseLearnedAnswer(asked.text, arabic, matcher);
  if (answer === 'unusable' || answer === 'discarded') return backOff(answer);

  const notes = learnedReviewerNotes(answers.map((a) => a.at));
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await store.recordDraft({
      accountId,
      topicId: topic.id,
      topicKey: key,
      gapIds,
      ref: learnedRef(deps.random),
      question: answer.question,
      answerEn: answer.answerEn,
      answerAr: answer.answerAr,
      notes,
      evidenceCount: evidence.answers.length,
    });
    if (res === 'drafted') return { drafted: true };
    if (res === 'already') return { drafted: false, reason: 'already' };
    if (res === 'disabled') return { drafted: false, reason: 'disabled' };
    if (res === 'error') return { drafted: false, reason: 'unrecorded' };
    if (res !== 'ref_taken') break;
  }
  // Asked and billed, but not storable: noted, so it counts this week.
  return backOff('refused');
}

/** What an account's run did; the error is null when it finished. */
export interface AccountRun {
  drafted: number;
  tried: number;
  error: KbLearnRunError | null;
}

/** One account's run, its AI config already loaded. Never throws. */
export async function learnAccount(
  deps: KbLearnDeps,
  accountId: string,
  config: AiConfig,
  deadlineAt: number
): Promise<AccountRun> {
  const now = deps.now ?? Date.now;
  const run: AccountRun = { drafted: 0, tried: 0, error: null };
  try {
    let left: number;
    let topics: LearnTopic[];
    let names: KnownName[];
    try {
      // A retry asks only what is left of the week's ten.
      left = MAX_TOPICS_PER_RUN - (await deps.store.askedThisWeek(accountId));
      if (left <= 0) return run;
      topics = await deps.store.openTopics(accountId);
      if (topics.length === 0) return run;
      // Once per run; a list that cannot be read in full stops the run.
      names = await deps.store.knownNames(accountId);
    } catch (err) {
      console.error(
        `[kb-learn] a read failed for account ${accountId}: ${message(err)}`
      );
      return { ...run, error: 'read_failed' };
    }
    const matcher = buildNameMatcher(names);
    // Last week's reviews first, so that this week's drafts use them.
    await evolveSkills(deps, accountId, config, matcher, deadlineAt);
    let skills: Skill[] = [];
    try {
      skills = await deps.store.activeSkills(accountId);
    } catch (err) {
      console.warn(
        `[kb-learn] no skills read for account ${accountId}: ${message(err)}`
      );
    }
    let modelFailures = 0; // in a row
    let readFailed = false;
    for (const topic of topics) {
      if (run.tried >= left) break;
      if (deadlineAt - now() < TOPIC_MIN_BUDGET_MS) {
        run.error = 'out_of_time';
        break;
      }
      try {
        const out = await learnTopic(
          deps,
          accountId,
          config,
          topic,
          names,
          matcher,
          skills
        );
        if (out.reason === 'disabled') return run;
        try {
          await deps.store.noteLook(
            accountId,
            topic.gapIds,
            out.reason === 'model'
          );
        } catch (err) {
          console.warn(
            `[kb-learn] a look was not noted for account ${accountId}: ${message(err)}`
          );
        }
        // A topic the model was asked about counts toward the cap.
        const asked = out.drafted || ASKED.has(out.reason ?? '');
        if (asked) run.tried++;
        if (out.drafted) run.drafted++;
        if (out.reason === 'unrecorded') return { ...run, error: 'failed' };
        if (out.reason === 'model') modelFailures++;
        else if (asked) modelFailures = 0;
        if (modelFailures >= MAX_MODEL_FAILURES) break;
      } catch (err) {
        readFailed = true;
        console.warn(
          `[kb-learn] a topic failed for account ${accountId}: ${message(err)}`
        );
      }
    }
    // The model still failing at the end (the last call of the run), then
    // a topic that could not be read; a lone failure the run moved past
    // waits for next week.
    if (modelFailures > 0) run.error = 'model';
    else if (readFailed && run.tried < left) run.error = 'read_failed';
  } catch (err) {
    console.error(
      `[kb-learn] run failed for account ${accountId}: ${message(err)}`
    );
    run.error = 'failed';
  }
  return run;
}

export interface EvolveResult {
  /** Reviews classified this run. */
  classified: number;
  /** The model was asked. */
  evolved: boolean;
  reason: EvolveReason | null;
  added: number;
}

/**
 * The skill library's cycle: classify the reviews of earlier drafts and,
 * when evolveDecision says so, ask the model for at most three new
 * general rules from the masked examples. One call at most, guarded as a
 * topic's: names known (`matcher`), time left, switch still on, once a
 * week. Never throws, and a failure never stops the drafting.
 */
export async function evolveSkills(
  deps: KbLearnDeps,
  accountId: string,
  config: AiConfig,
  matcher: NameMatcher,
  deadlineAt: number
): Promise<EvolveResult> {
  const now = deps.now ?? Date.now;
  const { store } = deps;
  const result: EvolveResult = {
    classified: 0,
    evolved: false,
    reason: null,
    added: 0,
  };
  try {
    // An erased draft is not one an admin rejected.
    const rows = (await store.reviewRows(accountId)).flatMap((r) =>
      r.draftAnswer === null ? [] : [{ ...r, draftAnswer: r.draftAnswer }]
    );
    const fresh: { id: string; outcome: ReviewOutcome }[] = [];
    const reviewed = rows.flatMap((r) => {
      const outcome = r.outcome ?? classifyReview(r.draftAnswer, r.entry);
      if (!outcome) return [];
      if (r.outcome === null) fresh.push({ id: r.id, outcome });
      return [{ ...r, outcome }];
    });
    if (fresh.length > 0) {
      await store.markReviewed(accountId, fresh);
      result.classified = fresh.length;
    }
    const undistilled = reviewed.filter((r) => !r.distilled);
    const decision = evolveDecision(
      undistilled.map((r) => r.outcome),
      reviewed.map((r) => r.outcome)
    );
    result.reason = decision.reason;
    if (!decision.evolve) return result;
    const examples = prepareExamples(
      undistilled.map((r) => ({
        topic: r.entry?.question ?? '',
        outcome: r.outcome,
        draft: r.draftAnswer,
        final: r.outcome === 'edited' ? (r.entry?.answer_en ?? null) : null,
      })),
      matcher
    );
    if (examples.length === 0) return result;
    const known = await store.skillTitles(accountId);
    const active = await store.activeSkills(accountId);
    // No room (318's cap): the reviews wait until one is retired.
    if (active.length >= MAX_ACTIVE_SKILLS) return result;
    const state = await store.distillState(accountId);
    const last = state.lastDistilledAt ? Date.parse(state.lastDistilledAt) : 0;
    if (!state.enabled) return result;
    if (last > 0 && now() - last < EVOLVE_INTERVAL_MS) return result;
    if (deadlineAt - now() < EVOLVE_MIN_BUDGET_MS) return result;

    const answer = await askModel(
      deps,
      accountId,
      config,
      buildDistillPrompt(examples, safeSkills(active, matcher))
    );
    if (answer === 'model') return result;
    result.evolved = true;
    // An unusable answer marks the reviews too, as a topic's backs off.
    result.added = await store.addSkills(
      accountId,
      answer === 'unusable'
        ? []
        : parseSkillUpdate(answer.text, known, examples.length, matcher),
      undistilled.map((r) => r.id)
    );
  } catch (err) {
    console.warn(
      `[kb-learn] the skill library failed for account ${accountId}: ${message(err)}`
    );
  }
  return result;
}

/**
 * The automations cron's pass: every account due, one at a time, each
 * claimed before it runs. Never throws.
 */
export async function runKbLearning(
  deps: KbLearnDeps = defaultDeps()
): Promise<{ accounts: number; drafted: number }> {
  const now = deps.now ?? Date.now;
  const started = now();
  const passDeadline = started + PASS_BUDGET_MS;
  let accounts = 0;
  let drafted = 0;
  try {
    const due = await deps.store.dueAccounts(new Date(started));
    for (const accountId of due) {
      if (passDeadline - now() < TOPIC_MIN_BUDGET_MS) break;
      // Before the claim: an account that cannot call the model at all
      // never counts as running. Claimed all the same, so it is retried
      // like any failure and does not hold a place in every pass.
      let config: AiConfig | null = null;
      let configError: KbLearnRunError = 'no_ai';
      try {
        config = await deps.loadConfig(accountId);
      } catch (err) {
        configError = 'read_failed';
        console.error(
          `[kb-learn] could not load the AI config for account ${accountId}: ${message(err)}`
        );
      }
      // One account's claim failing never ends the pass for the others.
      try {
        if (!(await deps.store.claimRun(accountId))) continue;
      } catch (err) {
        console.error(
          `[kb-learn] could not claim the run for account ${accountId}: ${message(err)}`
        );
        continue;
      }
      accounts++;
      const res: AccountRun = config?.apiKey
        ? await learnAccount(deps, accountId, config, passDeadline)
        : { drafted: 0, tried: 0, error: configError };
      drafted += res.drafted;
      try {
        await deps.store.finishRun(accountId, res.drafted, res.error);
      } catch (err) {
        console.warn(
          `[kb-learn] could not record the run for account ${accountId}: ${message(err)}`
        );
      }
    }
  } catch (err) {
    console.error(`[kb-learn] pass failed: ${message(err)}`);
  }
  return { accounts, drafted };
}

// ------------------------------------------------------------------
// The Supabase store (service role).
// ------------------------------------------------------------------

/**
 * Where an account's names are: customers and their companies, every
 * member (staff, coordinators, bank coordinators; a deactivated one too),
 * the companies of cases, and the bank people cases were discussed with.
 */
const NAME_SOURCES = [
  ['contacts', { name: 'person', company: 'company' }],
  ['profiles', { full_name: 'person' }],
  ['submission_groups', { customer_name: 'company' }],
] as const;
const NAMES_PAGE = 1000;

export function supabaseKbLearnStore(db: SupabaseClient): KbLearnStore {
  return {
    async dueAccounts(now) {
      // A row with last_run_at only (no next_run_at): a week after it,
      // as kb_learn_claim_run reads it.
      const weekAgo = new Date(
        now.getTime() - KB_LEARN_INTERVAL_DAYS * 86_400_000
      );
      const { data, error } = await db
        .from('kb_learn_settings')
        .select('account_id')
        .eq('enabled', true)
        .or(
          `next_run_at.lte.${now.toISOString()},` +
            'and(next_run_at.is.null,last_run_at.is.null),' +
            `and(next_run_at.is.null,last_run_at.lte.${weekAgo.toISOString()})`
        )
        .order('next_run_at', { ascending: true, nullsFirst: true })
        .limit(MAX_ACCOUNTS_PER_PASS);
      if (error) throw new Error(`settings: ${error.message}`);
      return ((data ?? []) as { account_id: string }[]).map(
        (r) => r.account_id
      );
    },
    async claimRun(accountId) {
      const { data, error } = await db.rpc('kb_learn_claim_run', {
        p_account: accountId,
      });
      if (error) throw new Error(`claim: ${error.message}`);
      return data === true;
    },
    async finishRun(accountId, drafted, runError) {
      const { error } = await db.rpc('kb_learn_finish_run', {
        p_account: accountId,
        p_drafted: drafted,
        p_error: runError,
      });
      if (error) throw new Error(`finish: ${error.message}`);
    },
    async askedThisWeek(accountId) {
      const { data, error } = await db.rpc('kb_learn_asked_this_week', {
        p_account: accountId,
      });
      if (error) throw new Error(`asked: ${error.message}`);
      if (typeof data !== 'number') throw new Error('asked: no count');
      return data;
    },
    async openTopics(accountId) {
      const { data, error } = await db.rpc('kb_learn_open_topics', {
        p_account: accountId,
        p_limit: MAX_TOPICS_READ,
      });
      if (error) throw new Error(`topics: ${error.message}`);
      return (
        (data ?? []) as (Omit<LearnTopic, 'gapIds'> & { gap_ids: string[] })[]
      ).map((t) => ({
        id: t.id,
        label: t.label,
        coverage: t.coverage,
        gapIds: t.gap_ids ?? [],
      }));
    },
    async topicDrafted(accountId, gapIds, topicKey) {
      const { data, error } = await db.rpc('kb_learn_topic_drafted', {
        p_account: accountId,
        p_gap_ids: gapIds,
        p_topic_key: topicKey,
      });
      if (error) throw new Error(`drafted: ${error.message}`);
      return data === true;
    },
    async noteLook(accountId, gapIds, modelFailed) {
      const { error } = await db.rpc('kb_learn_note_look', {
        p_account: accountId,
        p_gap_ids: gapIds,
        p_model_failed: modelFailed,
      });
      if (error) throw new Error(`look: ${error.message}`);
    },
    async gaps(accountId, ids) {
      if (ids.length === 0) return [];
      const { data, error } = await db
        .from('ai_knowledge_gaps')
        .select('id, conversation_id, question, created_at')
        .eq('account_id', accountId)
        .in('id', ids);
      if (error) throw new Error(`gaps: ${error.message}`);
      return (data ?? []) as LearnGap[];
    },
    async thread(accountId, conversationId, from, until) {
      const { data: conv, error: convError } = await db
        .from('conversations')
        .select('id, contact_id, personal_owner_id, inbox_department')
        .eq('id', conversationId)
        .eq('account_id', accountId)
        .maybeSingle();
      if (convError) throw new Error(`conversation: ${convError.message}`);
      if (!conv) return null;
      const c = conv as {
        contact_id: string | null;
        personal_owner_id: string | null;
        inbox_department: string | null;
      };
      if (!c.contact_id) return null;
      // HR, IT and accounts chats (the auto-reply's own rule). A read
      // error throws: the topic is skipped, not let through.
      if (
        await notSalesChat(db, {
          conversationId,
          inboxDepartment: c.inbox_department ?? null,
          inboundChannelId: null,
        })
      )
        return null;
      const { data: contact, error: contactError } = await db
        .from('contacts')
        .select('name, opted_out_at, do_not_contact_at')
        .eq('id', c.contact_id)
        .eq('account_id', accountId)
        .maybeSingle();
      if (contactError) throw new Error(`contact: ${contactError.message}`);
      if (!contact) return null;
      const k = contact as {
        name: string | null;
        opted_out_at: string | null;
        do_not_contact_at: string | null;
      };
      if (
        !isLearnableChat(
          { personal_owner_id: c.personal_owner_id ?? null },
          {
            opted_out_at: k.opted_out_at ?? null,
            do_not_contact_at: k.do_not_contact_at ?? null,
          }
        )
      )
        return null;
      const { data: rows, error } = await db
        .from('messages')
        .select(
          'id, sender_type, sender_id, content_type, content_text, template_name, created_at, channel_id, status, ai_generated, is_forwarded, reply_to_message_id'
        )
        .eq('conversation_id', conversationId)
        .gt('created_at', from)
        .lte('created_at', until)
        .order('created_at', { ascending: true })
        .limit(50);
      if (error) throw new Error(`messages: ${error.message}`);
      const messages = (rows ?? []) as ThreadMessage[];
      // The question itself came in at or just before the gap was noted.
      const { data: asked, error: askedError } = await db
        .from('messages')
        .select('id, channel_id, created_at')
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'customer')
        .lte('created_at', from)
        .order('created_at', { ascending: false })
        .limit(5);
      if (askedError) throw new Error(`question: ${askedError.message}`);
      const before = (asked ?? []) as {
        id: string;
        channel_id: string | null;
        created_at: string;
      }[];
      // The question is the customer's last burst before the gap.
      const questionIds = before
        .filter(
          (m) => Date.parse(from) - Date.parse(m.created_at) <= BURST_GAP_MS
        )
        .map((m) => m.id);
      const channels = new Set(
        [...messages, ...before]
          .map((m) => m.channel_id)
          .filter((id): id is string => typeof id === 'string')
      );
      for (const channel of channels)
        if (
          await notSalesChat(db, {
            conversationId,
            inboxDepartment: null,
            inboundChannelId: channel,
            readOnly: true,
          })
        )
          return null;
      const senders = [
        ...new Set(
          messages
            .map((m) => m.sender_id)
            .filter((id): id is string => typeof id === 'string')
        ),
      ];
      const senderNames: Record<string, string> = {};
      if (senders.length > 0) {
        const { data: people, error: peopleError } = await db
          .from('profiles')
          .select('user_id, full_name')
          .eq('account_id', accountId)
          .in('user_id', senders);
        if (peopleError) throw new Error(`senders: ${peopleError.message}`);
        for (const p of (people ?? []) as {
          user_id: string;
          full_name: string | null;
        }[])
          if (p.full_name) senderNames[p.user_id] = p.full_name;
      }
      return {
        messages,
        contactName: k.name ?? null,
        senderNames,
        questionIds,
      };
    },
    async knownNames(accountId) {
      const names = new Map<string, KnownName>();
      const keep = (name: string, kind: 'person' | 'company') =>
        names.set(`${kind}:${name}`, { name, kind });
      for (const [table, kinds] of NAME_SOURCES) {
        const columns = Object.keys(kinds);
        // By id, until an empty page: PostgREST cuts an unpaged read at
        // its row cap without saying so.
        let after: string | null = null;
        for (;;) {
          let query = db
            .from(table)
            .select(['id', ...columns].join(', '))
            .eq('account_id', accountId);
          if (after) query = query.gt('id', after);
          const { data, error } = await query
            .order('id', { ascending: true })
            .limit(NAMES_PAGE);
          if (error) throw new Error(`names (${table}): ${error.message}`);
          if (!Array.isArray(data))
            throw new Error(`names (${table}): no rows`);
          const rows = data as unknown as Record<string, string | null>[];
          if (rows.length === 0) break;
          for (const row of rows)
            for (const [col, kind] of Object.entries(kinds))
              if (row[col]) keep(row[col], kind);
          after = rows[rows.length - 1]!.id;
        }
      }
      let last: string | null = null;
      for (;;) {
        const { data, error } = await db.rpc('kb_learn_case_names', {
          p_account: accountId,
          p_after: last,
          p_limit: NAMES_PAGE,
        });
        if (error) throw new Error(`names (cases): ${error.message}`);
        if (!Array.isArray(data)) throw new Error('names (cases): no rows');
        const page = data as string[];
        if (page.length === 0) break;
        // Bank people and companies in one list: read as either.
        for (const name of page) {
          keep(name, 'person');
          keep(name, 'company');
        }
        last = page[page.length - 1]!;
      }
      return [...names.values()];
    },
    async recordDiscard(a) {
      const { data, error } = await db.rpc('kb_learn_record_discard', {
        p_account: a.accountId,
        p_topic_id: a.topicId,
        p_topic_key: a.topicKey,
        p_gap_ids: a.gapIds,
        p_evidence_count: a.evidenceCount,
      });
      if (error) throw new Error(`discard: ${error.message}`);
      // Not written (the switch is off, or the gaps are gone).
      if (data !== true) throw new Error('discard: not written');
    },
    async recordDraft(a) {
      const { data, error } = await db.rpc('kb_learn_record_draft', {
        p_account: a.accountId,
        p_topic_id: a.topicId,
        p_topic_key: a.topicKey,
        p_gap_ids: a.gapIds,
        p_ref: a.ref,
        p_question: a.question,
        p_answer_en: a.answerEn,
        p_answer_ar: a.answerAr,
        p_notes: a.notes,
        p_evidence_count: a.evidenceCount,
      });
      if (error) {
        console.error(`[kb-learn] record failed: ${error.message}`);
        return 'error';
      }
      const status = (data as { status?: string } | null)?.status;
      return status === 'drafted' ||
        status === 'disabled' ||
        status === 'already' ||
        status === 'invalid' ||
        status === 'ref_taken'
        ? status
        : 'error';
    },
    async activeSkills(accountId) {
      const { data, error } = await db
        .from('kb_learn_skills')
        .select(
          'id, kind, category, title, principle, when_to_apply, evidence_count'
        )
        .eq('account_id', accountId)
        .eq('status', 'active')
        .order('evidence_count', { ascending: false })
        .limit(MAX_ACTIVE_SKILLS);
      if (error) throw new Error(`skills: ${error.message}`);
      return ((data ?? []) as SkillRow[]).map(skillFromRow);
    },
    async skillTitles(accountId) {
      const { data, error } = await db
        .from('kb_learn_skills')
        .select('kind, title')
        .eq('account_id', accountId)
        .limit(500);
      if (error) throw new Error(`skill titles: ${error.message}`);
      return (data ?? []) as { kind: SkillKind; title: string }[];
    },
    async reviewRows(accountId) {
      const { data, error } = await db
        .from('kb_learned_drafts')
        .select('id, draft_answer_en, entry_id, reviewed_outcome, distilled_at')
        .eq('account_id', accountId)
        // A topic noted without a draft, a draft from before 318, an
        // erased one: none was reviewed by anyone.
        .is('discarded_at', null)
        .not('draft_answer_en', 'is', null)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw new Error(`ledger: ${error.message}`);
      const rows = (data ?? []) as {
        id: string;
        draft_answer_en: string | null;
        entry_id: string | null;
        reviewed_outcome: ReviewOutcome | null;
        distilled_at: string | null;
      }[];
      const ids = rows.flatMap((r) => (r.entry_id ? [r.entry_id] : []));
      const entries = new Map<string, NonNullable<ReviewRow['entry']>>();
      if (ids.length > 0) {
        const { data: es, error: entriesError } = await db
          .from('kb_entries')
          .select('id, status, question, answer_en')
          .eq('account_id', accountId)
          .in('id', ids);
        if (entriesError) throw new Error(`entries: ${entriesError.message}`);
        for (const { id, ...e } of (es ?? []) as ({
          id: string;
        } & NonNullable<ReviewRow['entry']>)[])
          entries.set(id, e);
      }
      return rows.flatMap((r) => {
        const entry = r.entry_id ? entries.get(r.entry_id) : null;
        // Gone between the two reads: an erase, or a delete. The next run
        // reads which.
        if (entry === undefined) return [];
        return [
          {
            id: r.id,
            draftAnswer: r.draft_answer_en,
            outcome: r.reviewed_outcome,
            distilled: r.distilled_at !== null,
            entry,
          },
        ];
      });
    },
    async markReviewed(accountId, rows) {
      const at = new Date().toISOString();
      for (const r of rows) {
        const { error } = await db
          .from('kb_learned_drafts')
          .update({ reviewed_outcome: r.outcome, reviewed_at: at })
          .eq('account_id', accountId)
          .eq('id', r.id)
          .is('reviewed_outcome', null);
        if (error) throw new Error(`review: ${error.message}`);
      }
    },
    async distillState(accountId) {
      const { data, error } = await db
        .from('kb_learn_settings')
        .select('enabled, last_distilled_at')
        .eq('account_id', accountId)
        .maybeSingle();
      if (error) throw new Error(`distill state: ${error.message}`);
      const row = data as {
        enabled: boolean;
        last_distilled_at: string | null;
      } | null;
      return {
        enabled: row?.enabled === true,
        lastDistilledAt: row?.last_distilled_at ?? null,
      };
    },
    async addSkills(accountId, skills, reviewIds) {
      const { data, error } = await db.rpc('kb_learn_add_skills', {
        p_account: accountId,
        p_skills: skills.map((s) => ({
          kind: s.kind,
          category: s.category,
          title: s.title,
          principle: s.principle,
          when_to_apply: s.whenToApply,
          evidence_count: s.evidenceCount,
        })),
        p_review_ids: reviewIds,
      });
      if (error) throw new Error(`add skills: ${error.message}`);
      return typeof data === 'number' ? data : 0;
    },
  };
}

interface SkillRow {
  id: string;
  kind: SkillKind;
  category: string | null;
  title: string;
  principle: string;
  when_to_apply: string | null;
  evidence_count: number;
}

function skillFromRow(r: SkillRow): Skill {
  return {
    id: r.id,
    kind: r.kind,
    category: isSkillCategory(r.category) ? r.category : null,
    title: r.title,
    principle: r.principle,
    whenToApply: r.when_to_apply,
    evidenceCount: r.evidence_count,
  };
}

/** Exported for the tests. */
export function defaultDeps(): KbLearnDeps {
  const db = supabaseAdmin();
  return {
    store: supabaseKbLearnStore(db),
    // Null while the workspace's AI master switch is off.
    loadConfig: (accountId) => loadAiConfig(db, accountId),
    generate: generateReply,
    logUsage: (args) => logAiUsage(db, args),
  };
}
