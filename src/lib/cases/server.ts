/**
 * Server-only wiring for cases (module 018c). Routes check the caller
 * first — including that the case's account is the caller's ACTIVE one
 * (see store.ts) — then act through these service-role stores. Every
 * factory builds on `supabaseAdmin()` with the default clock.
 */
import {
  submissionGroupService,
  supabaseAdmin,
} from '@/lib/submission-groups/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CaseSlaHook } from '@/lib/submission-groups/inbound';
import { SubmissionGroupSentNotRecordedError } from '@/lib/submission-groups/service';
import { SubmissionGroupStore } from '@/lib/submission-groups/store';
import type { IntakePorts, IntakeTemplateKind } from '@/lib/case-files/intake';
import { classifyAndCheck } from '@/lib/case-files/intake-file';
import {
  caseIntakeQueue,
  type CaseIntakeQueue,
} from '@/lib/case-files/intake-queue';
import { CaseFilesStore } from '@/lib/case-files/store';

import { isManagedExternally } from './access';
import { CaseBankContactsStore } from './bank-contacts';
import { BankWorkspaceStore } from './bank-workspaces';
import { CaseConversations } from './conversations';
import { BankDashboard } from './dashboard';
import { HANDOVER_TEMPLATE_DRAFT } from './handover';
import { assertUnderGroupSendLimit } from './http';
import { CaseInbox } from './inbox';
import { CaseMacroStore, type ApplyMacroDeps } from './macros';
import { CaseNotesStore } from './notes';
import { CaseSlaStore } from './sla';
import { CaseStore } from './store';
import { CaseToolsStore } from './tools';
import { CaseViews } from './views';

/**
 * With an account id, a final-stage move ends the submission group
 * through that account's 115 service; without one no claim is taken.
 */
export function caseStore(accountId?: string): CaseStore {
  const admin = supabaseAdmin();
  return new CaseStore(
    admin,
    accountId ? { ender: submissionGroupService(accountId, admin) } : {}
  );
}

export function caseMacroStore(): CaseMacroStore {
  return new CaseMacroStore(supabaseAdmin());
}

/**
 * Everything one macro run (186) acts through, on one service-role client
 * with one clock (`now` for every p_now). The case store ends the group of
 * a final-stage move exactly as the stage route's does. No sender: a macro
 * never sends.
 */
export function caseMacroDeps(
  accountId: string,
  now: Date
): Omit<ApplyMacroDeps, 'refusalText'> {
  const admin = supabaseAdmin();
  const clock = () => now;
  return {
    macros: new CaseMacroStore(admin, clock),
    cases: new CaseStore(admin, {
      ender: submissionGroupService(accountId, admin),
    }),
    tools: new CaseToolsStore(admin, clock),
    notes: new CaseNotesStore(admin, clock),
  };
}

export function caseToolsStore(): CaseToolsStore {
  return new CaseToolsStore(supabaseAdmin());
}

export function caseNotesStore(): CaseNotesStore {
  return new CaseNotesStore(supabaseAdmin());
}

export function caseBankContactsStore(): CaseBankContactsStore {
  return new CaseBankContactsStore(supabaseAdmin());
}

/** The SLA store on the service role (the SLA job and the routes). */
export function caseSlaStore(): CaseSlaStore {
  return new CaseSlaStore(supabaseAdmin());
}

/** The submission-group inbound path's customer_message hook, on the webhook's service-role client. */
export function caseSlaInboundHook(admin: SupabaseClient): CaseSlaHook {
  const cases = new CaseStore(admin);
  const sla = new CaseSlaStore(admin);
  return {
    caseIdForGroup: (groupId) => cases.idForGroup(groupId),
    customerMessage: (caseId) => sla.customerMessageSystem(caseId),
  };
}

export interface CaseIntakeOverrides {
  /** Defaults to `assertUnderGroupSendLimit` (throws `CaseHttpError`). */
  assertSendLimit?: (
    accountId: string,
    groupId: string,
    userId: string
  ) => Promise<void>;
  /** Defaults to `caseConversations(accountId).reply`. */
  reply?: (
    accountId: string,
    actor: string,
    caseId: string,
    text: string
  ) => Promise<unknown>;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function rpcError(fn: string, error: { code?: string; hint?: string }) {
  // Thrown as an object carrying `hint`: the core reads the refusal from it.
  return Object.assign(new Error(`${fn} failed`), {
    hint: error.hint ?? null,
    code: error.code ?? null,
  });
}

/** The core's `'classify'` is the SQL's `'document_classify'`. */
const SQL_TEMPLATE_KIND: Record<IntakeTemplateKind, string> = {
  classify: 'document_classify',
  document_rejected: 'document_rejected',
  document_received_next: 'document_received_next',
};

/** A send failure's code: `reason`, then `extra.code`, then the error name. */
function sendFailureCode(error: unknown): string {
  const e = error as { reason?: unknown; extra?: { code?: unknown } } | null;
  return (
    str(e?.reason) ??
    str(e?.extra?.code) ??
    (error instanceof Error ? error.name : 'unknown_error')
  );
}

/**
 * The tap-to-classify intake's ports (migration 183) on the webhook's
 * service-role client. The core decides; this only reads and writes.
 */
export function caseIntakePorts(
  admin: SupabaseClient,
  overrides: CaseIntakeOverrides = {}
): IntakePorts {
  const files = new CaseFilesStore(admin);
  const assertSendLimit =
    overrides.assertSendLimit ?? assertUnderGroupSendLimit;
  const reply =
    overrides.reply ??
    ((accountId: string, actor: string, caseId: string, text: string) =>
      caseConversations(accountId).reply(actor, caseId, text));
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw rpcError(fn, error);
    return data as unknown;
  };
  return {
    caseInfo: async (caseId) => {
      const { data, error } = await admin
        .from('cases')
        .select('account_id, group_id, coordinator_id, closed_at')
        .eq('id', caseId)
        .maybeSingle();
      if (error) throw rpcError('cases', error);
      if (!data) return null;
      const r = data as Record<string, unknown>;
      const groupId = str(r.group_id);
      const managed =
        (await rpc('case_managed_externally', {
          p_account: r.account_id,
        })) === true;
      return {
        accountId: String(r.account_id),
        groupId,
        coordinatorId: str(r.coordinator_id),
        closedAt: str(r.closed_at),
        managedExternally: isManagedExternally(
          { managedExternally: managed },
          { groupId }
        ),
      };
    },
    intakeEnabled: async (accountId) =>
      (await files.settings(accountId)).intakePrompts,
    approvedTemplate: async (accountId, kind) =>
      str(
        await rpc('case_intake_template_get', {
          p_account: accountId,
          p_kind: SQL_TEMPLATE_KIND[kind],
        })
      ),
    groupMode: async (groupId) =>
      (await new SubmissionGroupStore(admin).get(groupId))?.waMode ?? null,
    register: (caseId, customerDocumentId) =>
      files.register(null, caseId, customerDocumentId),
    checklist: async (caseId) => {
      const [spec, checklist] = await Promise.all([
        files.specRows(caseId),
        new CaseToolsStore(admin).checklist(caseId),
      ]);
      const labels = new Map(checklist.items.map((i) => [i.docKey, i.label]));
      return spec.map((s) => ({
        docKey: s.docKey,
        position: s.position,
        required: s.required,
        label: labels.get(s.docKey) ?? null,
      }));
    },
    passedDocKeys: async (caseId) =>
      (await files.listFiles(caseId))
        .filter((f) => f.status === 'passed' && f.docKey !== null)
        .map((f) => f.docKey as string),
    send: async ({ accountId, caseId, groupId, coordinatorId, text }) => {
      try {
        await assertSendLimit(accountId, groupId, coordinatorId);
        await reply(accountId, coordinatorId, caseId, text);
        return { sent: true, recorded: true };
      } catch (error) {
        if (error instanceof SubmissionGroupSentNotRecordedError)
          return { sent: true, recorded: false };
        return { sent: false, code: sendFailureCode(error) };
      }
    },
    recordPrompt: async ({ caseId, fileId, options, now }) => {
      await rpc('case_intake_prompt_record', {
        p_case: caseId,
        p_file: fileId,
        p_options: options.map((o) => ({
          n: o.n,
          doc_key: o.docKey,
          label: o.label,
        })),
        p_now: now.toISOString(),
      });
    },
    openPrompt: async (caseId) => {
      const data = await rpc('case_intake_open_prompt', { p_case: caseId });
      const r = (Array.isArray(data) ? data[0] : null) as Record<
        string,
        unknown
      > | null;
      if (!r) return null;
      const options = Array.isArray(r.options) ? r.options : [];
      return {
        id: String(r.prompt_id),
        fileId: String(r.file_id),
        options: options.map((o: Record<string, unknown>) => ({
          n: Number(o.n),
          docKey: String(o.doc_key),
          label: String(o.label ?? ''),
        })),
      };
    },
    answerPrompt: async ({ promptId, choice, now }) => {
      // The file id first: a failed read must not spend the answer.
      const { data, error } = await admin
        .from('case_intake_prompts')
        .select('file_id')
        .eq('prompt_id', promptId)
        .maybeSingle();
      if (error) throw rpcError('case_intake_prompts', error);
      const fileId = str((data as Record<string, unknown> | null)?.file_id);
      if (!fileId) throw rpcError('case_intake_prompts', {});
      const docKey = str(
        await rpc('case_intake_prompt_answer', {
          p_prompt: promptId,
          p_n: choice,
          p_now: now.toISOString(),
        })
      );
      if (!docKey) throw rpcError('case_intake_prompt_answer', {});
      return { fileId, docKey };
    },
    classifyAndCheck: async ({ fileId, docKey, today }) => {
      const out = await classifyAndCheck({
        admin,
        actor: null,
        fileId,
        docKey,
        today,
        deps: { storage: admin.storage },
      });
      return { status: out.status, checks: out.checks };
    },
    fileReady: (caseId) => files.fileReady(caseId),
  };
}

/** One delivery's intake queue (183) on the webhook's service-role client. */
export function caseIntakeQueueFor(
  admin: SupabaseClient,
  overrides: CaseIntakeOverrides = {}
): CaseIntakeQueue {
  const cases = new CaseStore(admin);
  return caseIntakeQueue({
    ports: caseIntakePorts(admin, overrides),
    caseIdForGroup: (groupId) => cases.idForGroup(groupId),
    documentIdFor: async (groupMessageId) => {
      const { data, error } = await admin
        .from('customer_documents')
        .select('id')
        .eq('group_message_id', groupMessageId)
        .maybeSingle();
      if (error) throw rpcError('customer_documents', error);
      return str((data as Record<string, unknown> | null)?.id);
    },
  });
}

export function caseInbox(): CaseInbox {
  return new CaseInbox(supabaseAdmin());
}

/** Saved views, snooze and mentions (185). Snooze: check tenancy first. */
export function caseViews(): CaseViews {
  return new CaseViews(supabaseAdmin());
}

/**
 * The case conversation for one account, on one service-role client. The
 * hand-over template is the DRAFT and drafts are not allowed, so a
 * take-over answers TEMPLATE_NOT_APPROVED until an approved template is
 * wired here.
 */
export function caseConversations(accountId: string): CaseConversations {
  const admin = supabaseAdmin();
  const groups = submissionGroupService(accountId, admin);
  return new CaseConversations({
    db: admin,
    store: new CaseStore(admin, { ender: groups }),
    groups,
    handover: { template: HANDOVER_TEMPLATE_DRAFT, allowDraftTemplate: false },
  });
}

/** Internal staff text: never wire this into a send path. */
export function bankWorkspaceStore(): BankWorkspaceStore {
  return new BankWorkspaceStore(supabaseAdmin());
}

export function bankDashboard(): BankDashboard {
  return new BankDashboard(supabaseAdmin());
}
