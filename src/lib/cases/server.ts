/**
 * Server-only wiring for cases (module 018c). Routes check the caller
 * first — including that the case's account is the caller's ACTIVE one
 * (see store.ts) — then act through this service-role store.
 */
import {
  submissionGroupService,
  supabaseAdmin,
} from '@/lib/submission-groups/server';
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
