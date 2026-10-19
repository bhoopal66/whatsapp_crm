/**
 * Request / response helpers for the internal bank workspace routes
 * (module 018c, `/api/banks/*`; the UI calls them "Banks").
 *
 * ACTIVE WORKSPACE: the bank_ws_* functions resolve the account from the
 * workspace / thread / post row and check the caller's access THERE,
 * which need not be the caller's active workspace. So every route first
 * finds the workspace in `list(caller, activeAccount)`, a thread in that
 * workspace's `threads`, and a post in one of those threads' `posts`;
 * anything else answers 404, so a non-member never learns it exists.
 *
 * INTERNAL TEXT: posts and pins are staff-only and never logged; errors
 * are logged by name / function / SQLSTATE only (caseErrorResponse).
 */
import { NextResponse } from 'next/server';

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

import {
  BankWorkspaceRefusedError,
  type BankWorkspace,
  type BankWorkspaceStore,
  type BankWsPost,
  type BankWsThread,
} from './bank-workspaces';
import { BankDashboardRefusedError } from './dashboard';
import { badRequest, caseErrorResponse, CaseHttpError, isUuid } from './http';

export const BANK_WS_NOT_FOUND = 'Bank workspace not found';
export const THREAD_NOT_FOUND = 'Thread not found';
export const POST_NOT_FOUND = 'Post not found';

/** bank_ws_create's rule: account owners and admins. */
export function canCreateBankWorkspace(role: AccountRole): boolean {
  return hasMinRole(role, 'admin');
}

type Caller = { accountId: string; userId: string };

/** The workspace, only when it is in the caller's ACTIVE-account list; else 404. */
export async function loadBankWorkspace(
  store: Pick<BankWorkspaceStore, 'list'>,
  ctx: Caller,
  id: string
): Promise<BankWorkspace> {
  if (!isUuid(id)) throw new CaseHttpError(404, BANK_WS_NOT_FOUND);
  const ws = (await store.list(ctx.userId, ctx.accountId)).find(
    (w) => w.bankWsId === id
  );
  if (!ws) throw new CaseHttpError(404, BANK_WS_NOT_FOUND);
  return ws;
}

/** The workspace and one of its threads the caller can list; else 404. */
export async function loadBankThread(
  store: Pick<BankWorkspaceStore, 'list' | 'threads'>,
  ctx: Caller,
  id: string,
  threadId: string
): Promise<{ workspace: BankWorkspace; thread: BankWsThread }> {
  const workspace = await loadBankWorkspace(store, ctx, id);
  if (!isUuid(threadId)) throw new CaseHttpError(404, THREAD_NOT_FOUND);
  const thread = (await store.threads(workspace.bankWsId, ctx.userId)).find(
    (t) => t.threadId === threadId
  );
  if (!thread) throw new CaseHttpError(404, THREAD_NOT_FOUND);
  return { workspace, thread };
}

/**
 * The workspace, and the post with its thread, when the post is in one of
 * the workspace's threads; else 404. Reads thread by thread, stopping at
 * the first match.
 */
export async function loadBankPost(
  store: Pick<BankWorkspaceStore, 'list' | 'threads' | 'posts'>,
  ctx: Caller,
  id: string,
  postId: string
): Promise<{
  workspace: BankWorkspace;
  thread: BankWsThread;
  post: BankWsPost;
}> {
  const workspace = await loadBankWorkspace(store, ctx, id);
  if (!isUuid(postId)) throw new CaseHttpError(404, POST_NOT_FOUND);
  for (const thread of await store.threads(workspace.bankWsId, ctx.userId)) {
    const post = (await store.posts(thread.threadId, ctx.userId)).find(
      (p) => p.postId === postId
    );
    if (post) return { workspace, thread, post };
  }
  throw new CaseHttpError(404, POST_NOT_FOUND);
}

/** A trimmed, non-blank string of at most `max` characters, or a 400. */
export function requiredText(v: unknown, field: string, max: number): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s === '' || s.length > max)
    throw badRequest(`${field} must be 1-${max} characters`);
  return s;
}

/** An optional uuid: absent / null -> null, a uuid -> it, else a 400. */
export function optionalUuid(v: unknown, field: string): string | null {
  if (v === undefined || v === null) return null;
  if (!isUuid(v)) throw badRequest(`${field} must be a uuid`);
  return v;
}

const REFUSAL_TEXT: Record<string, string> = {
  BANK_UNKNOWN: 'That bank is not set up in this workspace',
  KIND_INVALID: 'That pin kind is not valid',
  BODY_INVALID: 'That text is not valid',
  TITLE_INVALID: 'That title is not valid',
  LINK_INVALID: 'That case or task cannot be linked here',
  PARENT_INVALID: 'That post cannot be replied to here',
  ALREADY_RETRACTED: 'The post is already retracted',
  DUE_REQUIRED: 'A due date is required',
  DUE_INVALID: 'That due date is not valid',
  ALREADY_MARKED: 'The thread already has an action',
  OWNER_INVALID: 'That person cannot own this action',
  NOW_REQUIRED: 'A time is required',
  TEMPLATE_NOT_FOUND: 'The action task template is not set up',
};

const NOT_FOUND_TEXT: Record<string, string> = {
  BANK_WS_NOT_FOUND,
  THREAD_NOT_FOUND,
  POST_NOT_FOUND,
  CASE_NOT_FOUND: 'Case not found',
};

function refusal(code: string): NextResponse {
  if (code === 'NOT_ALLOWED')
    return NextResponse.json({ error: 'Not allowed', code }, { status: 403 });
  if (code in NOT_FOUND_TEXT)
    return NextResponse.json(
      { error: NOT_FOUND_TEXT[code], code },
      { status: 404 }
    );
  return NextResponse.json(
    { error: REFUSAL_TEXT[code] ?? 'Request refused', code },
    { status: 422 }
  );
}

/**
 * Any error a bank workspace route can meet, as a response: bank
 * workspace and dashboard refusals here, everything else (CaseHttpError,
 * a case refusal raised underneath, auth, store failures) through
 * caseErrorResponse, which logs no message text.
 */
export function bankErrorResponse(err: unknown): NextResponse {
  if (
    err instanceof BankWorkspaceRefusedError ||
    err instanceof BankDashboardRefusedError
  )
    return refusal(err.reason);
  return caseErrorResponse(err);
}
