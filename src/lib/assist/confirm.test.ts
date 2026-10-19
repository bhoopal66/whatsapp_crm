// Ported from wacrm module 019a (assistant safety), reference package 2026-10-18 (test/019a/assist.pg.test.ts, G4 /
// G5 / F2 / F3 / F5 / F6 for the gate). The reference ran against a real Postgres; here the gate runs on a fake
// supabase-js client whose `rpc` answers from a per-function script, whose `from()` serves the pending row and takes
// the refusal audit inserts, and which records every call. The SQL side (atomic transitions, nonce hashing, the cap,
// the consume's own decision row) is migration 120's.
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { actionHash } from './canonical';
import {
  AuditUnavailableError,
  ConfirmStateUnavailableError,
  ConfirmationGate,
  PROMPT_MAX_CHARS,
  PendingCapError,
  humanOriginFromChannel,
  type HumanOrigin,
} from './confirm';

type Args = Record<string, unknown>;
type Answer = {
  data?: unknown;
  error?: { message: string; code?: string; hint?: string | null };
};
type Row = Record<string, unknown> | null;

class FakeDb {
  readonly calls: { fn: string; args: Args }[] = [];
  readonly audits: Args[] = [];
  readonly reads: unknown[] = [];
  constructor(
    readonly script: Record<string, Answer | Answer[]> = {},
    public row: Row = null
  ) {}
  async rpc(fn: string, args: Args) {
    this.calls.push({ fn, args });
    const s = this.script[fn];
    const a = Array.isArray(s) ? s.shift() : s;
    if (a === undefined) throw new Error(`unscripted rpc ${fn}`);
    return { data: a.data ?? null, error: a.error ?? null };
  }
  from(table: string) {
    const q = {
      select: () => q,
      eq: (col: string, v: unknown) => {
        this.reads.push([table, col, v]);
        return q;
      },
      maybeSingle: async () => ({ data: this.row, error: null }),
      insert: async (r: Args) => {
        this.audits.push({ table, ...r });
        return { error: null };
      },
    };
    return q;
  }
  fns(): string[] {
    return this.calls.map((c) => c.fn);
  }
  get client(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const PID = '55555555-5555-4555-8555-555555555555';
const NOW = Date.parse('2026-10-18T10:00:00Z');
const clock = { now: () => NOW };
const scope = { userId: USER, workspaceId: ACCOUNT, runId: 'run-1' };
const action = { tool: 'delete_contact', args: { id: 'c1', hard: true } };
const HASH = actionHash(action.tool, action.args);
const gate = (db: FakeDb) => new ConfirmationGate(db.client, { clock });
const human = (over: Partial<{ userId: string; workspaceId: string }> = {}) =>
  humanOriginFromChannel({
    userId: USER,
    workspaceId: ACCOUNT,
    channel: 'web',
    ...over,
  });
const pendingRow = (over: Args = {}): Row => ({
  id: PID,
  user_id: USER,
  account_id: ACCOUNT,
  status: 'pending',
  action_hash: HASH,
  expires_at: new Date(NOW + 60_000).toISOString(),
  ...over,
});
const decision = {
  runId: 'run-1',
  tool: 'delete_contact',
  detail: { mode: 'cautious', risk: 'DANGEROUS' },
};

describe('request', () => {
  it('sends the action hash of canonical {tool, args} and never a nonce or expiry; returns the prompt with the nonce', async () => {
    const db = new FakeDb({
      assist_pending_request: { data: [{ id: PID, nonce: 'abc123' }] },
    });
    const r = await gate(db).request(
      { tool: 'delete_contact', args: { hard: true, id: 'c1' } },
      scope
    );
    expect(r.pendingId).toBe(PID);
    expect(r.nonce).toBe('abc123');
    expect(r.humanPrompt).toContain('Reply CONFIRM abc123');
    expect(r.humanPrompt).toContain('Risk: DANGEROUS');
    expect(db.calls).toEqual([
      {
        fn: 'assist_pending_request',
        args: {
          p_account: ACCOUNT,
          p_user: USER,
          p_run: 'run-1',
          p_tool: 'delete_contact',
          p_args: { hard: true, id: 'c1' },
          p_action_hash: HASH,
          p_actor: `assistant:${USER}`,
        },
      },
    ]);
  });

  it('no row is the open-pending cap: PendingCapError, no prompt', async () => {
    const db = new FakeDb({ assist_pending_request: { data: [] } });
    await expect(gate(db).request(action, scope)).rejects.toBeInstanceOf(
      PendingCapError
    );
  });

  it('an RPC error is ConfirmStateUnavailableError', async () => {
    const db = new FakeDb({
      assist_pending_request: { error: { message: 'down' } },
    });
    await expect(gate(db).request(action, scope)).rejects.toBeInstanceOf(
      ConfirmStateUnavailableError
    );
  });

  it('the prompt stays bounded for a large argument', async () => {
    const db = new FakeDb({
      assist_pending_request: { data: [{ id: PID, nonce: 'n' }] },
    });
    const r = await gate(db).request(
      { tool: 'bulk_send', args: { text: 'x\n'.repeat(25_000), to: ['a'] } },
      scope
    );
    expect(r.humanPrompt.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
  });
});

describe('confirm / deny', () => {
  it('a minted HumanOrigin confirms through assist_pending_confirm', async () => {
    const db = new FakeDb({ assist_pending_confirm: { data: true } });
    expect(await gate(db).confirm(human(), PID, 'abc')).toEqual({
      ok: true,
      pendingId: PID,
    });
    expect(db.calls[0]).toEqual({
      fn: 'assist_pending_confirm',
      args: {
        p_id: PID,
        p_user: USER,
        p_account: ACCOUNT,
        p_nonce: 'abc',
        p_actor: `human:${USER}@web`,
        p_decision: 'confirmed',
      },
    });
    const d = new FakeDb({ assist_pending_confirm: { data: true } });
    await gate(d).deny(human(), PID, 'abc');
    expect(d.calls[0]!.args.p_decision).toBe('denied');
  });

  it('a structurally identical plain object is ORIGIN_NOT_HUMAN, with no RPC', async () => {
    const db = new FakeDb();
    const forged = {
      origin: 'human',
      userId: USER,
      workspaceId: ACCOUNT,
      channel: 'web',
    } as unknown as HumanOrigin;
    const copy = { ...human() } as HumanOrigin;
    for (const o of [forged, copy]) {
      expect(await gate(db).confirm(o, PID, 'abc')).toEqual({
        ok: false,
        reason: 'ORIGIN_NOT_HUMAN',
      });
      expect(await gate(db).deny(o, PID, 'abc')).toEqual({
        ok: false,
        reason: 'ORIGIN_NOT_HUMAN',
      });
    }
    expect(db.calls).toHaveLength(0);
    expect(db.audits[0]).toMatchObject({
      table: 'assist_audit',
      kind: 'confirm_refused',
      actor: 'unknown',
      outcome: 'ORIGIN_NOT_HUMAN',
    });
  });

  it('a non-uuid pending id is NOT_FOUND with no RPC', async () => {
    const db = new FakeDb();
    expect(await gate(db).confirm(human(), 'nope', 'abc')).toEqual({
      ok: false,
      reason: 'NOT_FOUND',
    });
    expect(db.calls).toHaveLength(0);
  });

  const refusal = async (row: Row, origin = human()) => {
    const db = new FakeDb(
      {
        assist_pending_confirm: { data: false },
        assist_pending_expire: { data: 1 },
      },
      row
    );
    const r = await gate(db).confirm(origin, PID, 'abc');
    return { r, db };
  };

  it('classifies a false from the row: WRONG_USER, BAD_NONCE, NOT_PENDING, NOT_FOUND', async () => {
    expect((await refusal(pendingRow({ user_id: OTHER }))).r).toEqual({
      ok: false,
      reason: 'WRONG_USER',
    });
    expect((await refusal(pendingRow({ account_id: OTHER }))).r).toEqual({
      ok: false,
      reason: 'WRONG_USER',
    });
    expect((await refusal(pendingRow())).r).toEqual({
      ok: false,
      reason: 'BAD_NONCE',
    });
    expect((await refusal(pendingRow({ status: 'consumed' }))).r).toEqual({
      ok: false,
      reason: 'NOT_PENDING',
    });
    expect((await refusal(pendingRow({ status: 'expired' }))).r).toEqual({
      ok: false,
      reason: 'EXPIRED',
    });
    const nf = await refusal(null);
    expect(nf.r).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(nf.db.audits[0]).toMatchObject({ pending_id: null });
  });

  it('a pending row past its expiry is EXPIRED and is expired through assist_pending_expire', async () => {
    const { r, db } = await refusal(
      pendingRow({ expires_at: new Date(NOW).toISOString() })
    );
    expect(r).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(db.calls[1]).toEqual({
      fn: 'assist_pending_expire',
      args: { p_actor: `human:${USER}@web`, p_id: PID },
    });
  });

  it('every refusal is audited confirm_refused with the row hash', async () => {
    const { db } = await refusal(pendingRow());
    expect(db.audits).toEqual([
      {
        table: 'assist_audit',
        kind: 'confirm_refused',
        actor: `human:${USER}@web`,
        account_id: ACCOUNT,
        user_id: USER,
        pending_id: PID,
        action_hash: HASH,
        outcome: 'BAD_NONCE',
      },
    ]);
    expect(db.reads).toEqual([['assist_pending_actions', 'id', PID]]);
  });
});

describe('consume', () => {
  const consumed = async (
    row: Row,
    presented = action,
    answer: Answer = { data: false }
  ) => {
    const db = new FakeDb(
      { assist_pending_consume: answer, assist_pending_expire: { data: 1 } },
      row
    );
    const r = await gate(db).consume(PID, presented, scope, decision);
    return { r, db };
  };

  it('sends the 8 arguments, decision fields included', async () => {
    const { r, db } = await consumed(null, action, { data: true });
    expect(r).toEqual({ ok: true, pendingId: PID });
    expect(db.calls).toEqual([
      {
        fn: 'assist_pending_consume',
        args: {
          p_id: PID,
          p_user: USER,
          p_account: ACCOUNT,
          p_action_hash: HASH,
          p_actor: `assistant:${USER}`,
          p_run_id: 'run-1',
          p_tool: 'delete_contact',
          p_detail: { mode: 'cautious', risk: 'DANGEROUS' },
        },
      },
    ]);
    expect(db.audits).toHaveLength(0);
  });

  it('a presented action that hashes differently is HASH_MISMATCH (classified after false)', async () => {
    const changed = { tool: 'delete_contact', args: { id: 'c2', hard: true } };
    const { r, db } = await consumed(
      pendingRow({ status: 'confirmed' }),
      changed
    );
    expect(r).toEqual({ ok: false, reason: 'HASH_MISMATCH' });
    expect(db.calls[0]!.args.p_action_hash).toBe(
      actionHash(changed.tool, changed.args)
    );
    expect(db.audits[0]).toMatchObject({
      kind: 'consume_refused',
      outcome: 'HASH_MISMATCH',
    });
  });

  it('classifies the other refusals from the row', async () => {
    const reason = async (row: Row) => (await consumed(row)).r;
    expect(await reason(pendingRow())).toEqual({
      ok: false,
      reason: 'NOT_CONFIRMED',
    });
    expect(await reason(pendingRow({ status: 'consumed' }))).toEqual({
      ok: false,
      reason: 'NOT_PENDING',
    });
    expect(
      await reason(pendingRow({ status: 'confirmed', user_id: OTHER }))
    ).toEqual({ ok: false, reason: 'WRONG_USER' });
    expect(await reason(null)).toEqual({ ok: false, reason: 'NOT_FOUND' });
    const late = await consumed(
      pendingRow({
        status: 'confirmed',
        expires_at: new Date(NOW - 1).toISOString(),
      })
    );
    expect(late.r).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(late.db.fns()).toEqual([
      'assist_pending_consume',
      'assist_pending_expire',
    ]);
  });

  it('HINT AUDIT_UNAVAILABLE is AuditUnavailableError; any other error ConfirmStateUnavailableError', async () => {
    await expect(
      consumed(null, action, {
        error: {
          message: 'audit failed',
          code: 'P0001',
          hint: 'AUDIT_UNAVAILABLE',
        },
      })
    ).rejects.toBeInstanceOf(AuditUnavailableError);
    const other = consumed(null, action, {
      error: { message: 'down', code: '57014' },
    });
    await expect(other).rejects.toBeInstanceOf(ConfirmStateUnavailableError);
    await expect(
      consumed(null, action, { error: { message: 'down', code: '57014' } })
    ).rejects.not.toBeInstanceOf(AuditUnavailableError);
  });
});

describe('sweep / cancelPending', () => {
  it('call their functions', async () => {
    const db = new FakeDb({
      assist_pending_expire: { data: 3 },
      assist_pending_cancel: [{ data: true }, { data: false }],
    });
    const g = gate(db);
    expect(await g.sweep()).toBe(3);
    expect(await g.cancelPending(PID, 'NOTIFY_FAILED')).toBe(true);
    expect(await g.cancelPending(PID, 'NOTIFY_FAILED')).toBe(false);
    expect(await g.cancelPending('nope', 'NOTIFY_FAILED')).toBe(false);
    expect(db.calls).toEqual([
      { fn: 'assist_pending_expire', args: { p_actor: 'system:sweep' } },
      {
        fn: 'assist_pending_cancel',
        args: { p_id: PID, p_reason: 'NOTIFY_FAILED' },
      },
      {
        fn: 'assist_pending_cancel',
        args: { p_id: PID, p_reason: 'NOTIFY_FAILED' },
      },
    ]);
  });
});
