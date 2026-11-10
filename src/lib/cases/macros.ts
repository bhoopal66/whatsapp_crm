/**
 * Case macros (migration 186): a person's saved list of case actions,
 * applied to one case in one click.
 *
 *   CaseMacroStore — the 186 functions on the service role (list, get,
 *     save, delete, log_apply). Each resolves the actor's ACTIVE workspace
 *     itself; another person's private macro and another workspace's macro
 *     are MACRO_NOT_FOUND.
 *   applyMacro — runs a macro's actions in order through the same store
 *     methods the case routes use, AS THE CALLER, so every role, stage and
 *     Compass (MANAGED_EXTERNALLY) rule is re-checked by its own function.
 *     It stops at the first refused action; there is no transaction across
 *     actions, so the earlier ones stay applied. Every run that reached the
 *     actions writes exactly one case_macro_log row with every attempted
 *     action.
 *
 * request_documents is a PREVIEW: it reads what the missing-documents
 * request would say (case_doc_request_begin) and sends nothing. Nothing
 * here may call the send path or case_doc_mark_requested.
 *
 * The caller (the apply route) has already checked the case's account
 * against the caller's active account and the caller's write right.
 */
import { draftMissingDocumentsRequest } from './documents';
import type { CaseNotesStore } from './notes';
import { CaseRpc } from './rpc';
import {
  CaseRefusedError,
  CaseStoreError,
  rows,
  type CaseStore,
  type GroupEndOutcome,
} from './store';
import type { CaseToolsStore } from './tools';
import type { Case } from './types';

export type MacroAction =
  | {
      kind: 'add_task';
      templateKey: string;
      dueHours?: number;
      ownerRole: 'agent' | 'coordinator' | 'me';
    }
  | { kind: 'add_note'; body: string }
  | { kind: 'set_stage'; stage: string; outcome?: string }
  | { kind: 'request_documents' };

export type MacroActionKind = MacroAction['kind'];

export interface CaseMacro {
  id: string;
  accountId: string;
  ownerUserId: string;
  name: string;
  actions: MacroAction[];
  shared: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One attempted action of a run. */
export interface AppliedAction {
  kind: MacroActionKind;
  ok: boolean;
  /** The refusal code when `ok` is false. */
  code?: string;
  /** Its wording when `ok` is false. */
  reason?: string;
  /** set_stage only: the stage route's group-end outcome, when there is one. */
  groupEnd?: GroupEndOutcome;
}

export interface ApplyMacroResult {
  applied: AppliedAction[];
  documentRequestPreview?: string;
  stoppedAt?: { index: number; code: string; reason: string };
}

type Row = Record<string, unknown>;

const iso = (v: unknown): string => new Date(String(v)).toISOString();

export function toMacro(r: Row): CaseMacro {
  return {
    id: String(r.macro_id),
    accountId: String(r.account_id),
    ownerUserId: String(r.owner_user_id),
    name: String(r.name),
    actions: Array.isArray(r.actions) ? (r.actions as MacroAction[]) : [],
    shared: r.shared === true,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export class CaseMacroStore extends CaseRpc {
  async list(actor: string): Promise<CaseMacro[]> {
    return rows(await this.rpc('case_macro_list', { p_actor: actor })).map(
      toMacro
    );
  }

  async get(actor: string, macroId: string): Promise<CaseMacro> {
    return toMacro(
      await this.one('case_macro_get', { p_actor: actor, p_macro: macroId })
    );
  }

  /** Creates (macroId null) or updates the actor's own macro. */
  async save(
    actor: string,
    input: {
      macroId: string | null;
      name: unknown;
      actions: unknown;
      shared: boolean | null;
    }
  ): Promise<CaseMacro> {
    return toMacro(
      await this.one('case_macro_save', {
        p_actor: actor,
        p_macro: input.macroId,
        p_name: input.name,
        p_actions: input.actions,
        p_shared: input.shared,
      })
    );
  }

  async delete(actor: string, macroId: string): Promise<void> {
    await this.rpc('case_macro_delete', { p_actor: actor, p_macro: macroId });
  }

  /** Appends one case_macro_log row; returns its id. */
  async logApply(
    actor: string,
    caseId: string,
    macroId: string,
    applied: { kind: string; ok: boolean; refusal: string | null }[]
  ): Promise<string> {
    const data = await this.rpc('case_macro_log_apply', {
      p_actor: actor,
      p_case: caseId,
      p_macro: macroId,
      p_applied: applied,
      p_now: this.now(),
    });
    return String(data);
  }
}

export interface ApplyMacroDeps {
  macros: Pick<CaseMacroStore, 'get' | 'logApply'>;
  /** Built with the case's account, so a final stage ends the group. */
  cases: Pick<CaseStore, 'setStage'>;
  tools: Pick<CaseToolsStore, 'createTask' | 'docRequestBegin'>;
  notes: Pick<CaseNotesStore, 'add'>;
  /** The wording of a refusal code (http.ts's table). */
  refusalText: (code: string) => string;
}

const HOUR_MS = 3_600_000;
export const NO_GROUP_CODE = 'NO_GROUP';
const FAILED_CODE = 'FAILED';

/** {{customer}} and {{bank}}, inserted literally ($ is not special). */
export function fillNotePlaceholders(
  body: string,
  c: Pick<Case, 'contactName' | 'bankName'>
): string {
  return body
    .replace(/\{\{customer\}\}/g, () => c.contactName ?? '')
    .replace(/\{\{bank\}\}/g, () => c.bankName ?? '');
}

/** The person an add_task action names; NULL lets case_task_create choose. */
function taskOwner(
  role: 'agent' | 'coordinator' | 'me',
  c: Pick<Case, 'agentId' | 'coordinatorId'>,
  actor: string
): string | null {
  if (role === 'agent') return c.agentId;
  if (role === 'coordinator') return c.coordinatorId;
  return actor;
}

/**
 * Applies the macro to the (already checked) case. Throws CaseRefusedError
 * (NOT_ALLOWED / MACRO_NOT_FOUND) before anything is written when the
 * macro is not the caller's to use. A refused action is not an error: the
 * run stops there and the result says where.
 */
export async function applyMacro(
  deps: ApplyMacroDeps,
  input: { case: Case; actor: string; macroId: string; now: Date }
): Promise<ApplyMacroResult> {
  const { case: c, actor, now } = input;
  const macro = await deps.macros.get(actor, input.macroId);

  const applied: AppliedAction[] = [];
  const result: ApplyMacroResult = { applied };

  for (const [index, action] of macro.actions.entries()) {
    try {
      const entry: AppliedAction = { kind: action.kind, ok: true };
      switch (action.kind) {
        case 'add_task':
          await deps.tools.createTask({
            caseId: c.id,
            actor,
            templateKey: action.templateKey,
            ownerId: taskOwner(action.ownerRole, c, actor),
            dueAt:
              typeof action.dueHours === 'number'
                ? new Date(now.getTime() + action.dueHours * HOUR_MS)
                : null,
          });
          break;
        case 'add_note':
          await deps.notes.add(
            c.id,
            actor,
            fillNotePlaceholders(action.body, c)
          );
          break;
        case 'set_stage': {
          const r = await deps.cases.setStage(
            c.id,
            actor,
            action.stage,
            action.outcome ?? null
          );
          if (r.groupEnd) entry.groupEnd = r.groupEnd;
          break;
        }
        case 'request_documents': {
          // As the request route: a lead has no group to ask in.
          if (!c.groupId) throw new MacroStop(NO_GROUP_CODE);
          const begin = await deps.tools.docRequestBegin(c.id, actor);          if (begin.docLabels.length > 0)
            result.documentRequestPreview = draftMissingDocumentsRequest(
              begin.bankName ?? '',
              begin.docLabels
            );
          break;
        }
        default:
          throw new MacroStop('ACTION_INVALID');
      }
      applied.push(entry);
    } catch (err) {
      const code = stopCode(err);
      const reason = deps.refusalText(code);
      applied.push({ kind: action.kind, ok: false, code, reason });
      result.stoppedAt = { index, code, reason };
      break;
    }
  }

  try {
    await deps.macros.logApply(
      actor,
      c.id,
      macro.id,
      applied.map((a) => ({
        kind: a.kind,
        ok: a.ok,
        refusal: a.code ?? null,
      }))
    );
  } catch (err) {
    // The actions are applied; the caller still learns what happened.
    logFailure('log_apply', err);
  }
  return result;
}

class MacroStop extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function stopCode(err: unknown): string {
  if (err instanceof CaseRefusedError) return err.reason;
  if (err instanceof MacroStop) return err.code;
  logFailure('action', err);
  return FAILED_CODE;
}

/** Name / function / SQLSTATE only: never a message (customer data). */
function logFailure(step: string, err: unknown) {
  if (err instanceof CaseStoreError)
    console.error(`[cases] macro ${step} failed:`, err.fn, err.code);
  else
    console.error(
      `[cases] macro ${step} failed:`,
      err instanceof Error ? err.name : typeof err
    );
}
