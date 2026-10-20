/**
 * Bank workspaces (module 018c, migration 126): one internal workspace per
 * (account, bank) with a threaded discussion, versioned pins and "Action
 * needed" markers. Every method is ONE call of a SECURITY DEFINER
 * `bank_ws_*` function on a service-role client, with the actor passed as
 * a parameter; Postgres resolves the actor's access (bank_ws_access) and
 * decides everything. The list functions give a non-member ZERO rows, not
 * an error, and those pass through as empty lists.
 *
 * INTERNAL TEXT: posts and pins are staff-only. This module must never be
 * imported by a send path (never-sent.test.ts scans for it).
 *
 * ACTIVE WORKSPACE: `create` and `list` take the account; a route passes
 * the caller's ACTIVE account. The per-workspace methods resolve the
 * account from the bank workspace row.
 *
 * Refusals (an `error.hint` in BANK_WS_REFUSALS) throw
 * BankWorkspaceRefusedError; a case refusal raised underneath (the case
 * task an action creates) throws CaseRefusedError; anything else
 * CaseStoreError. Every write passes the injected clock as `p_now`.
 */
import { CaseRpc } from './rpc';
import { CaseStoreError, date, fail, rows, str } from './store';

/** 126's caps (the SQL enforces them). */
export const BANK_WS_CAPS = { title: 200, body: 4000, pin: 8000 } as const;

export const PIN_KINDS = [
  'bank_contacts',
  'product_rules',
  'required_documents',
  'turnaround_times',
  'known_pitfalls',
] as const;
export type PinKind = (typeof PIN_KINDS)[number];

/** bank_ws_list's `access`: account admins, or members through a case. */
export type BankWsAccess = 'member' | 'admin';

export const BANK_WS_REFUSALS = [
  'NOT_ALLOWED',
  'BANK_UNKNOWN',
  'BANK_WS_NOT_FOUND',
  'KIND_INVALID',
  'BODY_INVALID',
  'TITLE_INVALID',
  'LINK_INVALID',
  'THREAD_NOT_FOUND',
  'PARENT_INVALID',
  'POST_NOT_FOUND',
  'ALREADY_RETRACTED',
  'DUE_REQUIRED',
  'DUE_INVALID',
  'ALREADY_MARKED',
  'OWNER_INVALID',
  'NOW_REQUIRED',
  'CASE_NOT_FOUND',
  'TEMPLATE_NOT_FOUND',
] as const;
export type BankWsRefusal = (typeof BANK_WS_REFUSALS)[number];
const REFUSALS = new Set<string>(BANK_WS_REFUSALS);

export class BankWorkspaceRefusedError extends Error {
  override readonly name = 'BankWorkspaceRefusedError';
  constructor(readonly reason: BankWsRefusal) {
    super(`bank workspace refused: ${reason}`);
  }
}

export interface BankWorkspace {
  bankWsId: string;
  accountId: string;
  bankCode: string;
  bankName: string;
  access: BankWsAccess;
  createdAt: Date;
}

export interface BankWsCase {
  caseId: string;
  stage: string;
  product: string | null;
  agentId: string;
  coordinatorId: string | null;
  openedAt: Date;
  closedAt: Date | null;
  /** 131: the case's customer; name NULL when the contact has none / is gone. */
  contactId: string | null;
  contactName: string | null;
  /** 131: cases.sla_state ('overdue' | 'due_soon' | other), NULL when none. */
  slaState: string | null;
  /** 131: earliest due_at of the case's running SLA timers. */
  nextDueAt: Date | null;
  /** 131: a lead (no WhatsApp group yet). */
  isLead: boolean;
}

/** bank_ws_summary (131); `myRole` 'admin' for owner / admin access. */
export type BankWsRole = 'admin' | 'team_lead' | 'coordinator' | 'agent';
export interface BankWsSummary {
  openCases: number;
  members: {
    agents: number;
    coordinators: number;
    teamLeads: number;
    total: number;
  };
  openActions: number;
  myRole: BankWsRole | null;
}

export interface BankWsPin {
  pinId: string;
  kind: PinKind;
  body: string;
  authorId: string;
  createdAt: Date;
}

export interface BankWsThread {
  threadId: string;
  title: string;
  authorId: string;
  createdAt: Date;
  /** The root post's link. */
  caseId: string | null;
  taskId: string | null;
  postCount: number;
  actionOwnerId: string | null;
  actionDueAt: Date | null;
  actionTaskId: string | null;
}

export interface BankWsPost {
  postId: string;
  /** NULL: the thread's root post. */
  parentPostId: string | null;
  authorId: string;
  /** NULL once retracted. */
  body: string | null;
  retracted: boolean;
  caseId: string | null;
  taskId: string | null;
  /** false (and stage / product NULL) when the viewer may not read the linked case. */
  caseReadable: boolean;
  caseStage: string | null;
  caseProduct: string | null;
  createdAt: Date;
}

export interface BankWsAction {
  actionId: string;
  threadId: string;
  ownerId: string;
  dueAt: Date;
  caseId: string | null;
  taskId: string | null;
  /** NULL when unlinked or the viewer may not read the case. */
  taskStatus: string | null;
  createdBy: string;
  createdAt: Date;
}

/** A post's optional link: a case of the bank, or a task of one. */
export interface PostLink {
  caseId?: string | null;
  taskId?: string | null;
}

type Row = Record<string, unknown>;

/** A scalar uuid / bigint result (a bigint is a number, or a string past 2^53). */
function scalar(fn: string, data: unknown): string {
  if (typeof data === 'string' || typeof data === 'number') return String(data);
  throw new CaseStoreError(fn, null);
}

const toWorkspace = (r: Row): BankWorkspace => ({
  bankWsId: String(r.bank_ws_id),
  accountId: String(r.account_id),
  bankCode: String(r.bank_code),
  bankName: String(r.bank_name),
  access: String(r.access) as BankWsAccess,
  createdAt: date(r.created_at)!,
});

const toCase = (r: Row): BankWsCase => ({
  caseId: String(r.case_id),
  stage: String(r.stage),
  product: str(r.product),
  agentId: String(r.agent_id),
  coordinatorId: str(r.coordinator_id),
  openedAt: date(r.opened_at)!,
  closedAt: date(r.closed_at),
  contactId: str(r.contact_id),
  contactName: str(r.contact_name),
  slaState: str(r.sla_state),
  nextDueAt: date(r.next_due_at),
  isLead: r.is_lead === true,
});

const ROLES: readonly string[] = ['admin', 'team_lead', 'coordinator', 'agent'];
const n = (v: unknown): number => {
  const x = typeof v === 'string' ? Number(v) : v;
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0;
};

/** bank_ws_summary's jsonb -> BankWsSummary; SQL NULL (no access) -> null. */
export function parseBankWsSummary(data: unknown): BankWsSummary | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    return null;
  const d = data as Row;
  const m = (
    d.members && typeof d.members === 'object' ? d.members : {}
  ) as Row;
  return {
    openCases: n(d.open_cases),
    members: {
      agents: n(m.agents),
      coordinators: n(m.coordinators),
      teamLeads: n(m.team_leads),
      total: n(m.total),
    },
    openActions: n(d.open_actions),
    myRole: ROLES.includes(String(d.my_role))
      ? (d.my_role as BankWsRole)
      : null,
  };
}

const toPin = (r: Row): BankWsPin => ({
  pinId: String(r.pin_id),
  kind: String(r.kind) as PinKind,
  body: String(r.body ?? ''),
  authorId: String(r.author_id),
  createdAt: date(r.created_at)!,
});

const toThread = (r: Row): BankWsThread => ({
  threadId: String(r.thread_id),
  title: String(r.title),
  authorId: String(r.author_id),
  createdAt: date(r.created_at)!,
  caseId: str(r.case_id),
  taskId: str(r.task_id),
  postCount: Number(r.post_count ?? 0),
  actionOwnerId: str(r.action_owner_id),
  actionDueAt: date(r.action_due_at),
  actionTaskId: str(r.action_task_id),
});

const toPost = (r: Row): BankWsPost => ({
  postId: String(r.post_id),
  parentPostId: str(r.parent_post_id),
  authorId: String(r.author_id),
  body: str(r.body),
  retracted: r.retracted === true,
  caseId: str(r.case_id),
  taskId: str(r.task_id),
  caseReadable: r.case_readable === true,
  caseStage: str(r.case_stage),
  caseProduct: str(r.case_product),
  createdAt: date(r.created_at)!,
});

const toAction = (r: Row): BankWsAction => ({
  actionId: String(r.action_id),
  threadId: String(r.thread_id),
  ownerId: String(r.owner_id),
  dueAt: date(r.due_at)!,
  caseId: str(r.case_id),
  taskId: str(r.task_id),
  taskStatus: str(r.task_status),
  createdBy: String(r.created_by),
  createdAt: date(r.created_at)!,
});

export class BankWorkspaceStore extends CaseRpc {
  protected override async rpc(fn: string, args: Record<string, unknown>) {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) {
      if (typeof error.hint === 'string' && REFUSALS.has(error.hint))
        throw new BankWorkspaceRefusedError(error.hint as BankWsRefusal);
      fail(fn, error);
    }
    return data as unknown;
  }

  /** Account admins only; idempotent per (account, bank). Returns the id. */
  async create(
    actor: string,
    accountId: string,
    bankCode: string
  ): Promise<string> {
    const fn = 'bank_ws_create';
    return scalar(
      fn,
      await this.rpc(fn, {
        p_actor: actor,
        p_account: accountId,
        p_bank_code: bankCode,
        p_now: this.now(),
      })
    );
  }

  /** The bank workspaces of the account the actor has access to. */
  async list(actor: string, accountId: string): Promise<BankWorkspace[]> {
    const data = await this.rpc('bank_ws_list', {
      p_actor: actor,
      p_account: accountId,
    });
    return rows(data).map(toWorkspace);
  }

  /** The workspace's cases the actor may read, open and closed. */
  async cases(bankWsId: string, actor: string): Promise<BankWsCase[]> {
    const data = await this.rpc('bank_ws_cases', {
      p_bank_ws: bankWsId,
      p_actor: actor,
    });
    return rows(data).map(toCase);
  }

  /** The page header's figures (131); null when the actor has no access. */
  async summary(
    bankWsId: string,
    actor: string
  ): Promise<BankWsSummary | null> {
    return parseBankWsSummary(
      await this.rpc('bank_ws_summary', {
        p_bank_ws: bankWsId,
        p_actor: actor,
      })
    );
  }

  // ---------- pins ----------

  /** A new version of the kind; a blank body clears it. Returns the version id. */
  async setPin(
    bankWsId: string,
    actor: string,
    kind: PinKind,
    body: string
  ): Promise<string> {
    const fn = 'bank_ws_pin_set';
    return scalar(
      fn,
      await this.rpc(fn, {
        p_bank_ws: bankWsId,
        p_actor: actor,
        p_kind: kind,
        p_body: body,
        p_now: this.now(),
      })
    );
  }

  /**
   * The current pins (the latest version per kind, a cleared kind left
   * out), or with `history` every version, blank ones included.
   */
  async pins(
    bankWsId: string,
    actor: string,
    opts: { history?: boolean } = {}
  ): Promise<BankWsPin[]> {
    const history = opts.history === true;
    const data = await this.rpc('bank_ws_pins_list', {
      p_bank_ws: bankWsId,
      p_actor: actor,
      p_history: history,
    });
    const pins = rows(data).map(toPin);
    return history ? pins : pins.filter((p) => p.body.trim() !== '');
  }

  // ---------- threads and posts ----------

  /** A thread with its root post; the root post's link is the thread's. */
  async createThread(
    input: PostLink & {
      bankWsId: string;
      actor: string;
      title: string;
      body: string;
    }
  ): Promise<string> {
    const fn = 'bank_ws_thread_create';
    return scalar(
      fn,
      await this.rpc(fn, {
        p_bank_ws: input.bankWsId,
        p_actor: input.actor,
        p_title: input.title,
        p_body: input.body,
        p_case: input.caseId ?? null,
        p_task: input.taskId ?? null,
        p_now: this.now(),
      })
    );
  }

  async threads(bankWsId: string, actor: string): Promise<BankWsThread[]> {
    const data = await this.rpc('bank_ws_threads_list', {
      p_bank_ws: bankWsId,
      p_actor: actor,
    });
    return rows(data).map(toThread);
  }

  /** `parentPostId` null / absent: a reply to the root post. Returns the id. */
  async addPost(
    input: PostLink & {
      threadId: string;
      actor: string;
      parentPostId?: string | null;
      body: string;
    }
  ): Promise<string> {
    const fn = 'bank_ws_post_add';
    return scalar(
      fn,
      await this.rpc(fn, {
        p_thread: input.threadId,
        p_actor: input.actor,
        p_parent: input.parentPostId ?? null,
        p_body: input.body,
        p_case: input.caseId ?? null,
        p_task: input.taskId ?? null,
        p_now: this.now(),
      })
    );
  }

  /** Posts cannot be edited; the author may retract one (listings then hide the body). */
  async retractPost(postId: string, actor: string): Promise<void> {
    await this.rpc('bank_ws_post_retract', {
      p_post: postId,
      p_actor: actor,
      p_now: this.now(),
    });
  }

  async posts(threadId: string, actor: string): Promise<BankWsPost[]> {
    const data = await this.rpc('bank_ws_posts_list', {
      p_thread: threadId,
      p_actor: actor,
    });
    return rows(data).map(toPost);
  }

  // ---------- actions ----------

  /**
   * One per thread. On a case-linked thread a real case task is created
   * (template 'bank_ws_action_needed'). Returns the action id.
   */
  async markAction(input: {
    threadId: string;
    actor: string;
    ownerId: string;
    dueAt: Date | null;
  }): Promise<string> {
    if (input.dueAt && Number.isNaN(input.dueAt.getTime()))
      throw new BankWorkspaceRefusedError('DUE_INVALID');
    const fn = 'bank_ws_action_mark';
    return scalar(
      fn,
      await this.rpc(fn, {
        p_thread: input.threadId,
        p_actor: input.actor,
        p_owner: input.ownerId,
        p_due_at: input.dueAt ? input.dueAt.toISOString() : null,
        p_now: this.now(),
      })
    );
  }

  async actions(bankWsId: string, actor: string): Promise<BankWsAction[]> {
    const data = await this.rpc('bank_ws_actions_list', {
      p_bank_ws: bankWsId,
      p_actor: actor,
    });
    return rows(data).map(toAction);
  }
}
