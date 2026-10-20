/**
 * Ported from wacrm module 019e (assistant middleware), reference package 2026-10-20 (src/assist/middleware.builtin.ts).
 * wacrm changes: the redactor is the 019b port (src/lib/memory/redact.ts); pgAgentRunAuditSink (node-postgres) is
 * supabaseAgentRunAuditSink (supabase-js on the service-role client, migration 132); workspaceId is the account id.
 *
 * Built-in agent middleware (module 019e). Each one fails closed: an error is thrown, and runAgent turns it into an
 * AgentMiddlewareError that aborts the run.
 *   redactBeforeModel  every message (content, name and toolCallId) goes through the 019b redactor
 *                      (src/lib/memory/redact.ts) before the model sees it: in beforeModel (in place, so later hooks such
 *                      as a summariser see redacted text) and again as the pipeline's terminalRedact step, which runs
 *                      after every wrapModelCall layer immediately before deps.model, wherever this middleware sits in
 *                      the list. A refusal or a throwing redactor aborts the run.
 *   contextBudget      1) any single non-system message over maxMessageChars is offloaded through the injected
 *                      offload function and replaced by '[doc:<id>]' (id [A-Za-z0-9_.:-], 1..64 chars); it is never
 *                      inlined (an offload failure or an invalid id aborts the run). A system message is never
 *                      offloaded: one over maxMessageChars aborts the run (ContextBudgetError).
 *                      2) when the estimated tokens exceed maxTokens, the older messages (before the last
 *                      keepLastTurns user turns, system messages excluded) are replaced by one summary message from
 *                      the caller's summariser. If the summariser throws or returns no usable text, the oldest of
 *                      those messages are dropped until the budget fits: never the full history. System messages and
 *                      the last keepLastTurns turns are never dropped.
 *   auditAfterAgent    appends one audit row of kind 'agent_run' with counts only (rounds, tools proposed / allowed /
 *                      refused / pending); never message text or tool args. If the append fails the run's result is
 *                      withheld. supabaseAgentRunAuditSink writes it to public.assist_audit (needs migration 132).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  redact as defaultRedact,
  type RedactResult,
} from '@/lib/memory/redact';
import type {
  AgentMessage,
  AgentMiddleware,
  AgentResult,
  AgentRunCounts,
  AgentState,
} from './middleware';

// ---------------------------------------------------------------------------------------------------------------
// redactBeforeModel

export function redactBeforeModel(
  redactor: (text: string) => RedactResult = defaultRedact
): AgentMiddleware {
  const text = (t: string): string => {
    const r = redactor(t);
    if (
      r === null ||
      typeof r !== 'object' ||
      r.ok !== true ||
      typeof r.text !== 'string'
    ) {
      throw new Error('redaction refused a message');
    }
    return r.text;
  };
  const one = (m: AgentMessage): AgentMessage => {
    const role = m.role,
      content = m.content,
      toolCallId = m.toolCallId,
      name = m.name;
    const out: {
      role: AgentMessage['role'];
      content: string;
      toolCallId?: string;
      name?: string;
    } = { role, content: text(content) };
    if (toolCallId !== undefined) out.toolCallId = text(toolCallId);
    if (name !== undefined) out.name = text(name);
    return out;
  };
  return Object.freeze({
    name: 'redactBeforeModel',
    beforeModel: (state: AgentState) => {
      state.messages = state.messages.map(one);
    },
    terminalRedact: one,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// contextBudget

export interface ContextBudgetOptions {
  /** Estimated-token budget for the whole message list. */
  readonly maxTokens: number;
  /** A message whose content is longer than this is offloaded. */
  readonly maxMessageChars: number;
  /** User turns at the end that are never summarised or dropped (default 2). */
  readonly keepLastTurns?: number;
  /** Returns the summary text of the older messages. A throw or an unusable value falls back to truncation. */
  readonly summarise: (
    older: readonly AgentMessage[]
  ) => Promise<string> | string;
  /** Stores a non-system message out of band and returns its document id ([A-Za-z0-9_.:-], 1..64 chars). */
  readonly offload: (message: AgentMessage) => Promise<string> | string;
  readonly estimateTokens?: (message: AgentMessage) => number;
}

export const SUMMARY_PREFIX = 'Summary of the earlier conversation: ';
/** Ids are capped at 64 chars so an offload function cannot pass a large slice of the offloaded text back inline. */
const DOC_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** contextBudget cannot keep the run within its rules (a system message over maxMessageChars). */
export class ContextBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextBudgetError';
  }
}
export const docRef = (id: string): string => `[doc:${id}]`;
export const defaultEstimateTokens = (m: AgentMessage): number =>
  Math.ceil(m.content.length / 4) + 4;

export function contextBudget(opts: ContextBudgetOptions): AgentMiddleware {
  const keep = opts.keepLastTurns ?? 2;
  if (!Number.isInteger(opts.maxTokens) || opts.maxTokens < 1)
    throw new RangeError('contextBudget: maxTokens must be a positive integer');
  if (!Number.isInteger(opts.maxMessageChars) || opts.maxMessageChars < 16)
    throw new RangeError(
      'contextBudget: maxMessageChars must be an integer >= 16'
    );
  if (!Number.isInteger(keep) || keep < 1)
    throw new RangeError(
      'contextBudget: keepLastTurns must be a positive integer'
    );
  const estimate = opts.estimateTokens ?? defaultEstimateTokens;
  const total = (ms: readonly AgentMessage[]) =>
    ms.reduce((n, m) => n + estimate(m), 0);

  return Object.freeze({
    name: 'contextBudget',
    async beforeModel(state: AgentState) {
      // 1 offload: a message over the size cap never reaches the model inline.
      const msgs: AgentMessage[] = [];
      for (const m of state.messages) {
        if (m.content.length <= opts.maxMessageChars) {
          msgs.push(m);
          continue;
        }
        // Never offload a system message: the system prompt must reach the model inline or not at all.
        if (m.role === 'system')
          throw new ContextBudgetError(
            'contextBudget: a system message exceeds maxMessageChars'
          );
        const id = await opts.offload({ ...m });
        if (typeof id !== 'string' || !DOC_ID.test(id))
          throw new Error(
            'contextBudget: offload returned an invalid document id'
          );
        msgs.push({ ...m, content: docRef(id) });
      }
      // 2 budget
      if (total(msgs) <= opts.maxTokens) {
        state.messages = msgs;
        return;
      }
      const userIdx = msgs.flatMap((m, i) => (m.role === 'user' ? [i] : []));
      const tailStart =
        userIdx.length >= keep ? userIdx[userIdx.length - keep]! : 0;
      const head = msgs.slice(0, tailStart);
      const tail = msgs.slice(tailStart);
      const system = head.filter((m) => m.role === 'system');
      const older = head.filter((m) => m.role !== 'system');
      if (older.length === 0) {
        state.messages = msgs;
        return;
      }
      let summary: string | undefined;
      try {
        const s = await opts.summarise(
          older.map((m) => Object.freeze({ ...m }))
        );
        if (
          typeof s === 'string' &&
          s.trim().length > 0 &&
          SUMMARY_PREFIX.length + s.length <= opts.maxMessageChars
        )
          summary = s;
      } catch {
        summary = undefined;
      }
      if (summary !== undefined) {
        state.messages = [
          ...system,
          { role: 'assistant', content: SUMMARY_PREFIX + summary },
          ...tail,
        ];
        return;
      }
      // Summariser failed: truncate oldest first, never fall back to the full history.
      const kept = [...older];
      while (
        kept.length > 0 &&
        total([...system, ...kept, ...tail]) > opts.maxTokens
      )
        kept.shift();
      state.messages = [...system, ...kept, ...tail];
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// auditAfterAgent

export interface AgentRunAuditRow {
  readonly kind: 'agent_run';
  readonly runId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly channel: string;
  readonly outcome: AgentResult['status'];
  readonly detail: AgentRunCounts;
}

export type AgentRunAuditSink = (row: AgentRunAuditRow) => Promise<void>;

export function auditAfterAgent(append: AgentRunAuditSink): AgentMiddleware {
  return Object.freeze({
    name: 'auditAfterAgent',
    async afterAgent(state: AgentState, result: AgentResult) {
      const c = result.counts;
      await append(
        Object.freeze({
          kind: 'agent_run' as const,
          runId: state.runId,
          userId: state.userId,
          workspaceId: state.workspaceId,
          channel: state.channel,
          outcome: result.status,
          detail: Object.freeze({
            rounds: c.rounds,
            toolsProposed: c.toolsProposed,
            toolsAllowed: c.toolsAllowed,
            toolsRefused: c.toolsRefused,
            toolsPending: c.toolsPending,
          }),
        })
      );
    },
  });
}

/**
 * Writes the row to public.assist_audit (kind 'agent_run', actor 'system:assist', channel stored in detail) through a
 * service-role supabase-js client: 120 grants service_role INSERT on the table, so no function is needed. Throws on
 * any error, naming only the table and SQLSTATE (PostgREST's message text can carry row data).
 */
export function supabaseAgentRunAuditSink(
  db: SupabaseClient
): AgentRunAuditSink {
  return async (row) => {
    const { error } = await db.from('assist_audit').insert({
      kind: 'agent_run',
      actor: 'system:assist',
      account_id: row.workspaceId,
      user_id: row.userId,
      run_id: row.runId,
      outcome: row.outcome,
      detail: { ...row.detail, channel: row.channel },
    });
    if (error)
      throw new Error(
        `assist_audit agent_run insert failed${error.code ? ` (${error.code})` : ''}`
      );
  };
}
