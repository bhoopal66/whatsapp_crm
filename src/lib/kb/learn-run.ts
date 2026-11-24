/**
 * Learn from team answers (migration 290): the weekly cron job.
 *
 * For each workspace with the switch on whose last run is a week old
 * (kb_learn_claim_run stamps it first, so two crons never both run), up
 * to MAX_TOPICS_PER_RUN open gap topics without a live learned draft:
 * collect up to five team answers and the customer questions, redact
 * them (fail closed: a text that cannot be screened skips the topic),
 * ask the workspace's own AI key (model_small if set) for one general
 * answer, and store it through kb_learn_record_draft, which writes a
 * kb_entries DRAFT only. The bot's reply path and approved-answer
 * selection are untouched: a draft is never shortlisted.
 *
 * The model call goes through `generateReply`, which runs
 * `assertAiTransfer` (224) with purpose 'kb_learn' before anything is
 * sent, and masks identifiers again. Usage is logged as mode 'kb_learn'.
 *
 * Server-only, service role. Never throws; starts no new account or topic
 * after its time budget.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/ai/admin-client';
import { loadAiConfig } from '@/lib/ai/config';
import { generateReply } from '@/lib/ai/generate';
import type { AiConfig } from '@/lib/ai/types';
import { logAiUsage, type LogAiUsageArgs } from '@/lib/ai/usage';

import {
  ANSWER_WINDOW_MS,
  KB_LEARN_INTERVAL_DAYS,
  MAX_ANSWERS_PER_TOPIC,
  MIN_ANSWERS_PER_TOPIC,
  MAX_TOPICS_PER_RUN,
  buildLearnPrompt,
  cleanTopicLabel,
  isLearnableChat,
  learnedRef,
  learnedReviewerNotes,
  parseLearnedAnswer,
  pickTeamAnswer,
  redactEvidence,
  wantsArabic,
  type ThreadMessage,
} from './learn';

/** The cron pass starts no new account after this long. */
export const PASS_BUDGET_MS = 45_000;
/** No topic is started with less than this left (a model call). */
export const TOPIC_MIN_BUDGET_MS = 15_000;
/** Accounts looked at per pass. */
export const MAX_ACCOUNTS_PER_PASS = 20;
/** Gaps of a topic read to find answers. */
const MAX_GAPS_READ = 25;
/** Topics read per account (some are skipped as covered or drafted). */
const MAX_TOPICS_READ = 40;

export interface LearnTopic {
  id: string;
  label: string;
  coverage: string;
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
}

export type RecordDraftResult =
  'drafted' | 'disabled' | 'already' | 'invalid' | 'ref_taken' | 'error';

export interface RecordDraftArgs {
  accountId: string;
  topicId: string;
  topicLabel: string;
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
  dueAccounts(since: Date): Promise<string[]>;
  claimRun(accountId: string): Promise<boolean>;
  /** Records how many drafts the run wrote (the switch shows it). */
  finishRun(accountId: string, drafted: number): Promise<void>;
  openTopics(accountId: string): Promise<LearnTopic[]>;
  topicGapIds(accountId: string, topicId: string): Promise<string[]>;
  topicDrafted(
    accountId: string,
    gapIds: string[],
    label: string
  ): Promise<boolean>;
  gaps(accountId: string, ids: string[]): Promise<LearnGap[]>;
  thread(
    accountId: string,
    conversationId: string,
    from: string,
    until: string
  ): Promise<LearnThread | null>;
  recordDraft(args: RecordDraftArgs): Promise<RecordDraftResult>;
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
    | 'label'
    | 'model'
    | 'unusable'
    | 'refused'
    /** The switch went off while the run worked: stop the account. */
    | 'disabled';
}

/** Outcomes after which the model had been asked. */
const ASKED = new Set(['model', 'unusable', 'refused']);

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * One topic. Exported for the tests: the redaction gate, the evidence
 * and what reaches the model are asserted here.
 */
export async function learnTopic(
  deps: KbLearnDeps,
  accountId: string,
  config: AiConfig,
  topic: LearnTopic
): Promise<TopicOutcome> {
  const { store } = deps;
  // An approved answer already covers it (152's judgment): nothing to learn.
  if (topic.coverage === 'full' || topic.coverage === 'partial')
    return { drafted: false, reason: 'covered' };
  // The label as stored (redacted): the ledger compares this one.
  const label = cleanTopicLabel(topic.label);
  if (!label) return { drafted: false, reason: 'label' };
  const gapIds = await store.topicGapIds(accountId, topic.id);
  if (gapIds.length === 0) return { drafted: false, reason: 'no_answers' };
  if (await store.topicDrafted(accountId, gapIds, label))
    return { drafted: false, reason: 'already' };

  const gaps = (await store.gaps(accountId, gapIds.slice(0, MAX_GAPS_READ)))
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const answers: { text: string; names: string[]; at: string }[] = [];
  // Only questions from chats that may be learned from (not personal, not
  // opted out), each with its own customer's name masked.
  const questions: { text: string; names: string[] }[] = [];
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
    const reply = pickTeamAnswer(gap.created_at, thread.messages);
    if (!reply?.content_text) continue;
    const names = [
      thread.contactName ?? '',
      reply.sender_id ? (thread.senderNames[reply.sender_id] ?? '') : '',
    ].filter(Boolean);
    questions.push({ text: gap.question, names });
    answers.push({ text: reply.content_text, names, at: reply.created_at });
  }
  if (answers.length < MIN_ANSWERS_PER_TOPIC)
    return { drafted: false, reason: 'no_answers' };

  // Every name known in the topic's chats is masked in every text: a
  // customer may name someone from another chat. Fail closed: nothing
  // goes out unless every text was screened.
  const names = [...new Set(answers.flatMap((a) => a.names))];
  const redacted = redactEvidence({
    questions: questions.map((q) => ({ text: q.text, names })),
    answers: answers.map((a) => ({ text: a.text, names })),
  });
  if (!redacted.ok) return { drafted: false, reason: 'redaction' };
  const { evidence } = redacted;
  if (evidence.answers.length < MIN_ANSWERS_PER_TOPIC)
    return { drafted: false, reason: 'no_answers' };
  const arabic = wantsArabic(evidence.answers);
  const prompt = buildLearnPrompt({
    topic: label,
    questions: evidence.questions,
    answers: evidence.answers,
    arabic,
  });
  const model = config.modelSmall || config.model;
  let text: string;
  try {
    // generateReply runs assertAiTransfer (purpose 'kb_learn') first.
    const result = await deps.generate({
      config,
      systemPrompt: prompt.systemPrompt,
      messages: [{ role: 'user', content: prompt.userMessage }],
      model,
      purpose: 'kb_learn',
    });
    await deps.logUsage({
      accountId,
      conversationId: null,
      mode: 'kb_learn',
      provider: config.provider,
      model,
      usage: result.usage,
    });
    text = result.text;
  } catch (err) {
    console.warn(
      `[kb-learn] model call failed for account ${accountId}: ${message(err)}`
    );
    return { drafted: false, reason: 'model' };
  }
  const answer = parseLearnedAnswer(text, arabic);
  if (!answer) return { drafted: false, reason: 'unusable' };

  const notes = learnedReviewerNotes(answers.map((a) => a.at));
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await store.recordDraft({
      accountId,
      topicId: topic.id,
      topicLabel: label,
      gapIds,
      ref: learnedRef(deps.random),
      question: label,
      answerEn: answer.answerEn,
      answerAr: answer.answerAr,
      notes,
      evidenceCount: evidence.answers.length,
    });
    if (res === 'drafted') return { drafted: true };
    if (res === 'already') return { drafted: false, reason: 'already' };
    if (res === 'disabled') return { drafted: false, reason: 'disabled' };
    if (res !== 'ref_taken') break;
  }
  return { drafted: false, reason: 'refused' };
}

/** One account's run. Never throws. */
export async function learnAccount(
  deps: KbLearnDeps,
  accountId: string,
  deadlineAt: number
): Promise<{ drafted: number; tried: number }> {
  const now = deps.now ?? Date.now;
  let drafted = 0;
  let tried = 0;
  try {
    const config = await deps.loadConfig(accountId);
    if (!config?.apiKey) return { drafted, tried };
    const topics = await deps.store.openTopics(accountId);
    for (const topic of topics) {
      if (tried >= MAX_TOPICS_PER_RUN) break;
      if (deadlineAt - now() < TOPIC_MIN_BUDGET_MS) break;
      try {
        const out = await learnTopic(deps, accountId, config, topic);
        if (out.reason === 'disabled') break;
        // A topic the model was asked about counts toward the cap.
        if (out.drafted || ASKED.has(out.reason ?? '')) tried++;
        if (out.drafted) drafted++;
      } catch (err) {
        console.warn(
          `[kb-learn] a topic failed for account ${accountId}: ${message(err)}`
        );
      }
    }
  } catch (err) {
    console.error(
      `[kb-learn] run failed for account ${accountId}: ${message(err)}`
    );
  }
  return { drafted, tried };
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
    const since = new Date(started - KB_LEARN_INTERVAL_DAYS * 86_400_000);
    const due = await deps.store.dueAccounts(since);
    for (const accountId of due) {
      if (passDeadline - now() < TOPIC_MIN_BUDGET_MS) break;
      if (!(await deps.store.claimRun(accountId))) continue;
      accounts++;
      const res = await learnAccount(deps, accountId, passDeadline);
      drafted += res.drafted;
      try {
        await deps.store.finishRun(accountId, res.drafted);
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

export function supabaseKbLearnStore(db: SupabaseClient): KbLearnStore {
  return {
    async dueAccounts(since) {
      const { data, error } = await db
        .from('kb_learn_settings')
        .select('account_id, last_run_at')
        .eq('enabled', true)
        .or(`last_run_at.is.null,last_run_at.lte.${since.toISOString()}`)
        .order('last_run_at', { ascending: true, nullsFirst: true })
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
    async finishRun(accountId, drafted) {
      const { error } = await db.rpc('kb_learn_finish_run', {
        p_account: accountId,
        p_drafted: drafted,
      });
      if (error) throw new Error(`finish: ${error.message}`);
    },
    async openTopics(accountId) {
      const { data, error } = await db
        .from('kb_gap_topics')
        .select('id, label, coverage')
        .eq('account_id', accountId)
        .eq('status', 'open')
        .order('question_count', { ascending: false })
        .limit(MAX_TOPICS_READ);
      if (error) throw new Error(`topics: ${error.message}`);
      return (data ?? []) as LearnTopic[];
    },
    async topicGapIds(accountId, topicId) {
      const { data, error } = await db
        .from('kb_gap_topic_members')
        .select('gap_id')
        .eq('account_id', accountId)
        .eq('topic_id', topicId);
      if (error) throw new Error(`members: ${error.message}`);
      return ((data ?? []) as { gap_id: string }[]).map((r) => r.gap_id);
    },
    async topicDrafted(accountId, gapIds, label) {
      const { data, error } = await db.rpc('kb_learn_topic_drafted', {
        p_account: accountId,
        p_gap_ids: gapIds,
        p_label: label,
      });
      if (error) throw new Error(`drafted: ${error.message}`);
      return data === true;
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
        .select('id, contact_id, personal_owner_id')
        .eq('id', conversationId)
        .eq('account_id', accountId)
        .maybeSingle();
      if (convError) throw new Error(`conversation: ${convError.message}`);
      if (!conv) return null;
      const c = conv as {
        contact_id: string | null;
        personal_owner_id: string | null;
      };
      if (!c.contact_id) return null;
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
          'sender_type, sender_id, content_type, content_text, template_name, created_at'
        )
        .eq('conversation_id', conversationId)
        .gt('created_at', from)
        .lte('created_at', until)
        .order('created_at', { ascending: true })
        .limit(50);
      if (error) throw new Error(`messages: ${error.message}`);
      const messages = (rows ?? []) as ThreadMessage[];
      const senders = [
        ...new Set(
          messages
            .map((m) => m.sender_id)
            .filter((id): id is string => typeof id === 'string')
        ),
      ];
      const senderNames: Record<string, string> = {};
      if (senders.length > 0) {
        const { data: people } = await db
          .from('profiles')
          .select('user_id, full_name')
          .eq('account_id', accountId)
          .in('user_id', senders);
        for (const p of (people ?? []) as {
          user_id: string;
          full_name: string | null;
        }[])
          if (p.full_name) senderNames[p.user_id] = p.full_name;
      }
      return { messages, contactName: k.name ?? null, senderNames };
    },
    async recordDraft(a) {
      const { data, error } = await db.rpc('kb_learn_record_draft', {
        p_account: a.accountId,
        p_topic_id: a.topicId,
        p_topic_label: a.topicLabel,
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
  };
}

function defaultDeps(): KbLearnDeps {
  const db = supabaseAdmin();
  return {
    store: supabaseKbLearnStore(db),
    loadConfig: (accountId) =>
      loadAiConfig(db, accountId, { requireActive: false }),
    generate: generateReply,
    logUsage: (args) => logAiUsage(db, args),
  };
}
