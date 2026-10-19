/**
 * Server-only wiring for cases (module 018c). Routes check the caller
 * first — including that the case's account is the caller's ACTIVE one
 * (see store.ts) — then act through this service-role store.
 */
import {
  submissionGroupService,
  supabaseAdmin,
} from '@/lib/submission-groups/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CaseSlaHook } from '@/lib/submission-groups/inbound';
import { CaseSlaStore } from './sla';
import { CaseStore } from './store';

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

/** The SLA store on the service role (the SLA job and the inbound hook). */
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
