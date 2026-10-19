/**
 * The shared supabase-js plumbing of the case tool stores (module 018c,
 * migrations 123-124): one SECURITY DEFINER `case_*` RPC per write, plain
 * service-role SELECTs for listings (they decide nothing about access: a
 * route checks the case's account and the caller's read right first).
 * Refusals throw CaseRefusedError, anything else CaseStoreError (store.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { CaseStoreError, fail, rows } from './store';

export type Row = Record<string, unknown>;

export class CaseRpc {
  constructor(
    protected readonly db: SupabaseClient,
    /** The clock every write passes as `p_now`. */
    protected readonly clock: () => Date = () => new Date()
  ) {}

  protected now(): string {
    return this.clock().toISOString();
  }

  protected async rpc(fn: string, args: Record<string, unknown>) {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) fail(fn, error);
    return data as unknown;
  }

  protected async one(fn: string, args: Record<string, unknown>) {
    const row = rows(await this.rpc(fn, args))[0];
    if (!row) throw new CaseStoreError(fn, null);
    return row;
  }

  /** Rows matching every `eq`, ordered ascending by `order` (in turn). */
  protected async select(
    table: string,
    columns: string,
    eq: Record<string, string>,
    order: readonly string[]
  ): Promise<Row[]> {
    let q = this.db.from(table).select(columns);
    for (const [k, v] of Object.entries(eq)) q = q.eq(k, v);
    for (const o of order) q = q.order(o, { ascending: true });
    const { data, error } = await q;
    if (error) throw new CaseStoreError(table, error.code ?? null);
    return rows(data);
  }
}
