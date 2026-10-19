/**
 * Case tools (module 018c, migration 123): tasks, the document checklist
 * and their per-bank configuration, over a service-role supabase-js client.
 *
 *   Tasks — created only from a template of the case's bank (owner defaults
 *     to the case's agent, due to now + the template's due_hours); status
 *     open | done | blocked, every change logged; overdue is computed by
 *     case_task_overdue at the given clock, never stored.
 *   Documents — required per (account, bank, product); a document is
 *     missing until 'received'. The request to the customer is
 *     documents.ts; docRequestBegin / docMarkRequested are its two RPCs.
 *   Config — task templates and document requirements, owner/admin only.
 *
 * Internal case text lives in other modules (see never-sent.test.ts): this
 * file is on the send path through documents.ts.
 *
 * ACTIVE WORKSPACE (as store.ts): a route checks the case's account is the
 * caller's active one before calling a method that takes an actor, and its
 * read right before a listing (the listings decide nothing).
 */
import { CaseRpc, type Row } from './rpc';
import { date, rows, str } from './store';

export type TaskStatus = 'open' | 'done' | 'blocked';
export type DocStatus = 'requested' | 'received' | 'rejected';

export interface CaseTask {
  id: string;
  caseId: string;
  templateKey: string;
  title: string;
  ownerId: string;
  dueAt: Date | null;
  /** The current status (the latest logged change). */
  status: TaskStatus;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  /** The latest status-log row; NULL only if the log read found none. */
  lastChange: {
    fromStatus: TaskStatus | null;
    toStatus: TaskStatus;
    actorId: string;
    actorRole: string;
    changedAt: Date;
  } | null;
}

export interface OverdueTask {
  taskId: string;
  caseId: string;
  title: string;
  ownerId: string;
  dueAt: Date;
  status: TaskStatus;
}

export interface ChecklistItem {
  docKey: string;
  label: string;
  position: number;
  /** NULL: not requested yet. */
  status: DocStatus | null;
  fileRef: string | null;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export interface CaseChecklist {
  items: ChecklistItem[];
  /** Required documents not received, in checklist order. */
  missing: string[];
}

export interface TaskTemplate {
  accountId: string;
  bankCode: string;
  templateKey: string;
  title: string;
  position: number;
  dueHours: number | null;
}

export interface DocRequirement {
  accountId: string;
  bankCode: string;
  product: string;
  docKey: string;
  label: string;
  position: number;
}

/** What case_doc_request_begin returns: the missing documents of the case. */
export interface DocRequestBegin {
  accountId: string;
  groupId: string;
  submissionRef: string | null;
  /** NULL for a case with no bank (then nothing is required). */
  bankName: string | null;
  docKeys: string[];
  docLabels: string[];
}

const TASK_COLUMNS =
  'id, case_id, template_key, title, owner_id, due_at, status, created_by, created_at, updated_at';

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : [];
const productKey = (p: unknown) =>
  String(p ?? '')
    .trim()
    .toLowerCase();

const toTemplate = (r: Row): TaskTemplate => ({
  accountId: String(r.account_id),
  bankCode: String(r.bank_code),
  templateKey: String(r.template_key),
  title: String(r.title),
  position: Number(r.position),
  dueHours:
    r.due_hours === null || r.due_hours === undefined
      ? null
      : Number(r.due_hours),
});

const toRequirement = (r: Row): DocRequirement => ({
  accountId: String(r.account_id),
  bankCode: String(r.bank_code),
  product: String(r.product),
  docKey: String(r.doc_key),
  label: String(r.label),
  position: Number(r.position),
});

export class CaseToolsStore extends CaseRpc {
  // ---------- tasks ----------

  /** Returns the new task's id. */
  async createTask(input: {
    caseId: string;
    actor: string;
    templateKey: string;
    ownerId?: string | null;
    dueAt?: Date | null;
  }): Promise<string> {
    const data = await this.rpc('case_task_create', {
      p_case: input.caseId,
      p_actor: input.actor,
      p_template_key: input.templateKey,
      p_owner: input.ownerId ?? null,
      p_due_at: input.dueAt ? input.dueAt.toISOString() : null,
      p_now: this.now(),
    });
    return String(data);
  }

  async setTaskStatus(
    taskId: string,
    actor: string,
    status: TaskStatus
  ): Promise<{
    changed: boolean;
    fromStatus: TaskStatus;
    toStatus: TaskStatus;
  }> {
    const row = await this.one('case_task_set_status', {
      p_task: taskId,
      p_actor: actor,
      p_status: status,
      p_now: this.now(),
    });
    return {
      changed: row.changed === true,
      fromStatus: String(row.from_status) as TaskStatus,
      toStatus: String(row.to_status) as TaskStatus,
    };
  }

  /**
   * Not done and due before `now`, over the cases of `accountId` the actor
   * may read (the account is explicit: one login works in several).
   */
  async overdueTasks(
    actor: string,
    accountId: string,
    now?: Date
  ): Promise<OverdueTask[]> {
    const data = await this.rpc('case_task_overdue', {
      p_actor: actor,
      p_account: accountId,
      p_now: (now ?? this.clock()).toISOString(),
    });
    return rows(data).map((t) => ({
      taskId: String(t.task_id),
      caseId: String(t.case_id),
      title: String(t.title),
      ownerId: String(t.owner_id),
      dueAt: date(t.due_at)!,
      status: String(t.status) as TaskStatus,
    }));
  }

  /** The case's tasks, oldest first, each with its latest status change. */
  async listTasks(caseId: string): Promise<CaseTask[]> {
    const [tasks, log] = await Promise.all([
      this.select('case_tasks', TASK_COLUMNS, { case_id: caseId }, [
        'created_at',
        'id',
      ]),
      this.select(
        'case_task_status_log',
        'id, task_id, from_status, to_status, actor_id, actor_role, changed_at',
        { case_id: caseId },
        ['id']
      ),
    ]);
    const last = new Map<string, Row>();
    for (const l of log) last.set(String(l.task_id), l);
    return tasks.map((t) => {
      const l = last.get(String(t.id));
      return {
        id: String(t.id),
        caseId: String(t.case_id),
        templateKey: String(t.template_key),
        title: String(t.title),
        ownerId: String(t.owner_id),
        dueAt: date(t.due_at),
        status: String(t.status) as TaskStatus,
        createdBy: String(t.created_by),
        createdAt: date(t.created_at)!,
        updatedAt: date(t.updated_at)!,
        lastChange: l
          ? {
              fromStatus: str(l.from_status) as TaskStatus | null,
              toStatus: String(l.to_status) as TaskStatus,
              actorId: String(l.actor_id),
              actorRole: String(l.actor_role),
              changedAt: date(l.changed_at)!,
            }
          : null,
      };
    });
  }

  // ---------- documents ----------

  /** 'received' needs `fileRef` (an id of the stored file, never content). */
  async setDocStatus(input: {
    caseId: string;
    actor: string;
    docKey: string;
    status: DocStatus;
    fileRef?: string | null;
  }): Promise<DocStatus> {
    const data = await this.rpc('case_doc_set_status', {
      p_case: input.caseId,
      p_actor: input.actor,
      p_doc_key: input.docKey,
      p_status: input.status,
      p_file_ref: input.fileRef ?? null,
      p_now: this.now(),
    });
    return String(data) as DocStatus;
  }

  /**
   * The case's required documents (its account, bank and product; the
   * product matched case-insensitively on trimmed text, as 123) with their
   * statuses. A case with no bank or product, or none found, has none.
   */
  async checklist(caseId: string): Promise<CaseChecklist> {
    const [c] = await this.select(
      'cases',
      'account_id, bank_code, product',
      { id: caseId },
      []
    );
    if (!c || c.bank_code === null || c.product === null)
      return { items: [], missing: [] };
    const [reqs, docs] = await Promise.all([
      this.select(
        'case_doc_requirements',
        'account_id, bank_code, product, doc_key, label, position',
        { account_id: String(c.account_id), bank_code: String(c.bank_code) },
        ['position', 'doc_key']
      ),
      this.select(
        'case_documents',
        'doc_key, status, file_ref, updated_by, updated_at',
        { case_id: caseId },
        ['doc_key']
      ),
    ]);
    const byKey = new Map(docs.map((d) => [String(d.doc_key), d]));
    const items = reqs
      .filter((r) => productKey(r.product) === productKey(c.product))
      .map((r): ChecklistItem => {
        const d = byKey.get(String(r.doc_key));
        return {
          docKey: String(r.doc_key),
          label: String(r.label),
          position: Number(r.position),
          status: (str(d?.status) as DocStatus | null) ?? null,
          fileRef: str(d?.file_ref),
          updatedBy: str(d?.updated_by),
          updatedAt: date(d?.updated_at),
        };
      });
    return {
      items,
      missing: items
        .filter((i) => i.status !== 'received')
        .map((i) => i.docKey),
    };
  }

  /** For the actor who may act on the case: what the request needs. */
  async docRequestBegin(
    caseId: string,
    actor: string
  ): Promise<DocRequestBegin> {
    const row = await this.one('case_doc_request_begin', {
      p_case: caseId,
      p_actor: actor,
    });
    return {
      accountId: String(row.account_id),
      groupId: String(row.group_id),
      submissionRef: str(row.submission_ref),
      bankName: str(row.bank_name),
      docKeys: strings(row.doc_keys),
      docLabels: strings(row.doc_labels),
    };
  }

  /** After the request was sent; returns how many rows it wrote. */
  async docMarkRequested(
    caseId: string,
    actor: string,
    docKeys: readonly string[]
  ): Promise<number> {
    const data = await this.rpc('case_doc_mark_requested', {
      p_case: caseId,
      p_actor: actor,
      p_doc_keys: [...docKeys],
      p_now: this.now(),
    });
    return Number(data ?? 0);
  }

  // ---------- config (owner/admin of the account) ----------

  async upsertTaskTemplate(
    actor: string,
    t: Omit<TaskTemplate, 'position' | 'dueHours'> & {
      position?: number | null;
      dueHours?: number | null;
    }
  ): Promise<TaskTemplate> {
    return toTemplate(
      await this.one('case_task_template_upsert', {
        p_actor: actor,
        p_account: t.accountId,
        p_bank_code: t.bankCode,
        p_template_key: t.templateKey,
        p_title: t.title,
        p_position: t.position ?? null,
        p_due_hours: t.dueHours ?? null,
      })
    );
  }

  async deleteTaskTemplate(
    actor: string,
    accountId: string,
    bankCode: string,
    templateKey: string
  ): Promise<boolean> {
    const data = await this.rpc('case_task_template_delete', {
      p_actor: actor,
      p_account: accountId,
      p_bank_code: bankCode,
      p_template_key: templateKey,
    });
    return data === true;
  }

  async upsertDocRequirement(
    actor: string,
    r: Omit<DocRequirement, 'position'> & { position?: number | null }
  ): Promise<DocRequirement> {
    return toRequirement(
      await this.one('case_doc_requirement_upsert', {
        p_actor: actor,
        p_account: r.accountId,
        p_bank_code: r.bankCode,
        p_product: r.product,
        p_doc_key: r.docKey,
        p_label: r.label,
        p_position: r.position ?? null,
      })
    );
  }

  async deleteDocRequirement(
    actor: string,
    accountId: string,
    bankCode: string,
    product: string,
    docKey: string
  ): Promise<boolean> {
    const data = await this.rpc('case_doc_requirement_delete', {
      p_actor: actor,
      p_account: accountId,
      p_bank_code: bankCode,
      p_product: product,
      p_doc_key: docKey,
    });
    return data === true;
  }

  /** One bank's templates and requirements (no access decision). */
  async bankConfig(
    accountId: string,
    bankCode: string
  ): Promise<{ templates: TaskTemplate[]; requirements: DocRequirement[] }> {
    const eq = { account_id: accountId, bank_code: bankCode };
    const [templates, requirements] = await Promise.all([
      this.select(
        'case_task_templates',
        'account_id, bank_code, template_key, title, position, due_hours',
        eq,
        ['position', 'template_key']
      ),
      this.select(
        'case_doc_requirements',
        'account_id, bank_code, product, doc_key, label, position',
        eq,
        ['product', 'position', 'doc_key']
      ),
    ]);
    return {
      templates: templates.map(toTemplate),
      requirements: requirements.map(toRequirement),
    };
  }
}
