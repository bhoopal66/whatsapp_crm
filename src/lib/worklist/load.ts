/**
 * The reads behind "My worklist" (`rank.ts`), all existing ones: the
 * HR reads the hire fast page makes (through the caller's RLS client,
 * so only chats they can already see), the pending agent drafts, and
 * the Cases screen's GET /api/cases. Each source fails on its own: an
 * error, a refusal (403 for a department kept out of the sales areas)
 * or a throw counts as empty, and this never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { EMPTY_FILTERS, inboxUrl, parseInboxPage } from '@/lib/cases/ui';
import { HR_TASK_REF_PREFIX } from '@/lib/hr/tasks-view';
import type { HrInbox } from '@/lib/hr/types';

import type {
  WorklistCase,
  WorklistDraft,
  WorklistHrConversation,
  WorklistHrTask,
  WorklistInputs,
  WorklistRule,
} from './rank';

/** The case inbox's page cap (INBOX_MAX_LIMIT in lib/cases/inbox.ts). */
export const WORKLIST_CASE_LIMIT = 200;
const HR_LIMIT = 500;
const TASK_LIMIT = 1000;
const DRAFT_LIMIT = 200;

const HR_SELECT =
  'conversation_id, inbox, stage_key, urgent, upset, reply_state, last_inbound_at, last_outbound_at, closed_at, created_at, chat:conversations(assigned_agent_id)';
const DRAFT_SELECT =
  'id, conversation_id, status, created_at, hr:hr_conversations(inbox, chat:conversations(assigned_agent_id))';

type Row = Record<string, unknown>;

/** An embedded to-one relation, whether PostgREST gave an object or a list. */
function one(v: unknown): Row | null {
  const x = Array.isArray(v) ? v[0] : v;
  return x && typeof x === 'object' ? (x as Row) : null;
}

function ownerOf(chat: unknown): string | null {
  const id = one(chat)?.assigned_agent_id;
  return typeof id === 'string' ? id : null;
}

async function rows(
  query: PromiseLike<{ data: unknown; error: unknown }>
): Promise<Row[]> {
  try {
    const { data, error } = await query;
    return !error && Array.isArray(data) ? (data as Row[]) : [];
  } catch {
    return [];
  }
}

async function loadCases(fetchImpl: typeof fetch): Promise<WorklistCase[]> {
  try {
    const res = await fetchImpl(
      inboxUrl(EMPTY_FILTERS, null, WORKLIST_CASE_LIMIT),
      { cache: 'no-store' }
    );
    if (!res.ok) return [];
    return parseInboxPage(await res.json()).rows;
  } catch {
    return [];
  }
}

export async function loadWorklistInputs(
  supabase: SupabaseClient,
  fetchImpl: typeof fetch,
  now: number = Date.now()
): Promise<WorklistInputs> {
  const [convs, tasks, rules, drafts, cases] = await Promise.all([
    rows(
      supabase
        .from('hr_conversations')
        .select(HR_SELECT)
        .is('closed_at', null)
        .limit(HR_LIMIT)
    ),
    rows(
      supabase
        .from('tasks')
        .select('status, due_at, source_ref')
        .eq('status', 'open')
        .like('source_ref', `${HR_TASK_REF_PREFIX}%`)
        .lt('due_at', new Date(now).toISOString())
        .limit(TASK_LIMIT)
    ),
    rows(
      supabase
        .from('hr_workflow_rules')
        .select('key, enabled, after_hours')
        .eq('key', 'no_activity_recruiter')
    ),
    rows(
      supabase
        .from('hr_agent_drafts')
        .select(DRAFT_SELECT)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(DRAFT_LIMIT)
    ),
    loadCases(fetchImpl),
  ]);
  return {
    hrConversations: convs.map(
      ({ chat, ...r }) =>
        ({ ...r, ownerId: ownerOf(chat) }) as unknown as WorklistHrConversation
    ),
    hrTasks: tasks as unknown as WorklistHrTask[],
    hrRules: rules as unknown as WorklistRule[],
    drafts: drafts.map((d): WorklistDraft => {
      const hr = one(d.hr);
      return {
        id: String(d.id),
        conversation_id: String(d.conversation_id),
        status: String(d.status),
        created_at: String(d.created_at),
        inbox: (hr?.inbox as HrInbox | undefined) ?? null,
        ownerId: ownerOf(hr?.chat),
      };
    }),
    cases,
  };
}
