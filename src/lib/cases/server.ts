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

import { CaseBankContactsStore } from './bank-contacts';
import { BankWorkspaceStore } from './bank-workspaces';
import { CaseConversations } from './conversations';
import { BankDashboard } from './dashboard';
import { HANDOVER_TEMPLATE_DRAFT } from './handover';
import { CaseInbox } from './inbox';
import { CaseNotesStore } from './notes';
import { CaseSlaStore } from './sla';
import { CaseStore } from './store';
import { CaseToolsStore } from './tools';

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

export function caseInbox(): CaseInbox {
  return new CaseInbox(supabaseAdmin());
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
