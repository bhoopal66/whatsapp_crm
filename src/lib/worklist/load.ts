/**
 * The reads behind "My worklist" (`rank.ts`), all existing ones: the
 * HR reads the hire fast page makes (through the caller's RLS client,
 * so only chats they can already see), the pending agent drafts, and
 * the Cases screen's GET /api/cases. Each source fails on its own and
 * is named in `failed`; this never throws. Two answers are an honest
 * empty rather than a failure: a 403 from the case inbox (a department
 * kept out of the sales areas) and an HR table that is not there.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  EMPTY_FILTERS,
  appendRows,
  inboxUrl,
  parseInboxPage,
  type InboxRow,
} from '@/lib/cases/ui';
import { HR_TASK_REF_PREFIX } from '@/lib/hr/tasks-view';
import type { HrInbox } from '@/lib/hr/types';
import { isMissingTable } from '@/lib/team-activity/db-errors';

import {
  WORKLIST_CASE_MAX,
  type WorklistPart,
  type WorklistRead,
} from './load-state';
import type {
  WorklistCase,
  WorklistDraft,
  WorklistHrConversation,
  WorklistHrTask,
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

/** The rows; null when the read failed. */
async function rows(
  query: PromiseLike<{ data: unknown; error: { code?: string } | null }>
): Promise<Row[] | null> {
  try {
    const { data, error } = await query;
    if (error) return isMissingTable(error) ? [] : null;
    return Array.isArray(data) ? (data as Row[]) : null;
  } catch {
    return null;
  }
}

interface CasesRead {
  cases: WorklistCase[];
  /** More cases match than `WORKLIST_CASE_MAX`. */
  truncated: boolean;
}

const NO_CASES: CasesRead = { cases: [], truncated: false };

/**
 * The cases, page by page: the person and team filters run on what is
 * read here, so a first page alone hid a person's cases behind everyone
 * else's. Null when the first page failed; after that what was read is
 * kept and marked cut, never a silently shorter list.
 */
async function loadCases(fetchImpl: typeof fetch): Promise<CasesRead | null> {
  let cases: InboxRow[] = [];
  try {
    let after: string | null = null;
    for (let read = 0; read < WORKLIST_CASE_MAX; read += WORKLIST_CASE_LIMIT) {
      const res: Response = await fetchImpl(
        inboxUrl(EMPTY_FILTERS, after, WORKLIST_CASE_LIMIT),
        { cache: 'no-store' }
      );
      if (res.status === 403 && after === null) return NO_CASES;
      // What was read stays, and says it is not all of it.
      if (!res.ok) return after === null ? null : { cases, truncated: true };
      const page = parseInboxPage(await res.json());
      cases = appendRows(cases, page.rows);
      after = page.nextCursor;
      if (after === null) return { cases, truncated: false };
    }
    return { cases, truncated: true };
  } catch {
    return cases.length > 0 ? { cases, truncated: true } : null;
  }
}

export async function loadWorklistInputs(
  supabase: SupabaseClient,
  fetchImpl: typeof fetch,
  now: number = Date.now(),
  // `cases: false` skips GET /api/cases, which a department kept out of
  // the sales areas is always refused (migration 192).
  { cases: readCases = true }: { cases?: boolean } = {}
): Promise<WorklistRead> {
  const [convs, tasks, rules, drafts, cases] = await Promise.all([
    rows(
      supabase
        .from('hr_conversations')
        .select(HR_SELECT)
        .is('closed_at', null)
        // Newest customer message first, so the cap drops the stalest chats.
        .order('last_inbound_at', { ascending: false, nullsFirst: false })
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
    readCases ? loadCases(fetchImpl) : Promise.resolve(NO_CASES),
  ]);
  const failed: WorklistPart[] = [];
  if (!convs || !tasks || !rules) failed.push('hr');
  if (!drafts) failed.push('drafts');
  if (!cases) failed.push('cases');
  const inputs = {
    hrConversations: (convs ?? []).map(
      ({ chat, ...r }) =>
        ({ ...r, ownerId: ownerOf(chat) }) as unknown as WorklistHrConversation
    ),
    hrTasks: (tasks ?? []) as unknown as WorklistHrTask[],
    hrRules: (rules ?? []) as unknown as WorklistRule[],
    drafts: (drafts ?? []).map((d): WorklistDraft => {
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
    cases: cases?.cases ?? [],
  };
  return { inputs, failed, casesTruncated: cases?.truncated ?? false };
}
