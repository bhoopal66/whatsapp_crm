/**
 * The decision layer's only database access: read an account's active
 * approved policy, append a decision-log row. Kept behind this narrow
 * interface so the checks can be tested without a database, and so the
 * service-role client stays the only writer (migration 063 grants
 * `authenticated` no INSERT on ts_decision_log).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { parsePartnerBanks, type PartnerBanksSetting } from './admin-types';
import type { AccountSwitches, CheckName } from './config';

export interface PolicyRow {
  version: number;
  model_id: string;
  question_set_version: string;
  thresholds: unknown;
  shadow: boolean;
}

/** Column values for one `ts_decision_log` insert. */
export interface DecisionRow {
  account_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  check_name: CheckName;
  policy_version: number | null;
  model_id: string | null;
  question_set_version: string;
  language: string | null;
  state_hash: string;
  answers: unknown;
  decision: string;
  reason_codes: string[];
  acted: boolean;
  shadow: boolean;
  fallback_used: boolean;
  latency_ms: number | null;
  input_tokens: number | null;
  error_code: string | null;
}

export interface TsStore {
  /** The account's active policy for `check`, or null. Throws on a read error. */
  activePolicy(accountId: string, check: CheckName): Promise<PolicyRow | null>;
  /**
   * The account's own switches (migration 064): null when it never saved
   * any, which means off. Throws on a read error. Optional: a store
   * without it (tests, the evaluation harness) leaves the install
   * configuration to decide.
   */
  accountSwitches?(accountId: string): Promise<AccountSwitches | null>;
  /** Appends a row and returns its id. Throws on a write error. */
  insertDecision(row: DecisionRow): Promise<string | null>;
}

/** The switch columns of a `ts_account_settings` row. */
export interface SwitchesRow {
  enabled: boolean;
  mode: string;
  triage: boolean;
  guardrail: boolean;
  passages: boolean;
  watch_human_threads: boolean;
  languages: string;
  /** Migration 078; NULL = the built-in list. Absent when the read did
   *  not select it (a pre-078 database). Read it through
   *  parsePartnerBanks: the CHECK holds only the envelope. */
  partner_banks?: PartnerBanksSetting | null;
}

const SWITCH_COLUMNS =
  'enabled, mode, triage, guardrail, passages, watch_human_threads, languages';

/**
 * PostgREST's answer to a select naming a column the table does not have
 * (Postgres 42703, or PGRST204 from the schema cache): a database that
 * has not run the migration adding it yet.
 */
export function isUndefinedColumn(
  error: { code?: string; message?: string } | null,
  column: string
): boolean {
  if (!error) return false;
  if (error.code === '42703' || error.code === 'PGRST204') return true;
  return (
    (error.message ?? '').includes(column) &&
    /does not exist|could not find/i.test(error.message ?? '')
  );
}

export function switchesFromRow(r: SwitchesRow): AccountSwitches {
  return {
    enabled: r.enabled,
    mode: r.mode === 'live' ? 'live' : 'monitor',
    checks: {
      triage: r.triage,
      guardrail: r.guardrail,
      passages: r.passages,
      // Not wired to a host step; never switched on from Settings.
      eligibility: false,
    },
    watchHumanThreads: r.watch_human_threads,
    languages: r.languages === 'all' ? 'all' : 'english',
    // Absent (not selected) stays absent: SwitchesStore.set keeps the
    // partner banks it already knows rather than reverting to the
    // built-in list on a save whose row did not carry the column.
    ...('partner_banks' in r
      ? { partnerBanks: parsePartnerBanks(r.partner_banks) }
      : {}),
  };
}

/** Store over a service-role Supabase client. */
export function supabaseStore(db: SupabaseClient): TsStore {
  return {
    async activePolicy(accountId, check) {
      const { data, error } = await db
        .from('ts_policy')
        .select('version, model_id, question_set_version, thresholds, shadow')
        .eq('account_id', accountId)
        .eq('check_name', check)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as PolicyRow | null) ?? null;
    },
    async accountSwitches(accountId) {
      const read = (columns: string) =>
        db
          .from('ts_account_settings')
          .select(columns)
          .eq('account_id', accountId)
          .maybeSingle();
      let { data, error } = await read(`${SWITCH_COLUMNS}, partner_banks`);
      // Before migration 078: the switches still apply, with the
      // built-in partner list.
      if (isUndefinedColumn(error, 'partner_banks'))
        ({ data, error } = await read(SWITCH_COLUMNS));
      if (error) throw new Error(error.message);
      if (!data) return null;
      const row = data as unknown as SwitchesRow;
      return switchesFromRow({ partner_banks: null, ...row });
    },
    async insertDecision(row) {
      const { data, error } = await db
        .from('ts_decision_log')
        .insert(row)
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      return (data as { id: string } | null)?.id ?? null;
    },
  };
}
