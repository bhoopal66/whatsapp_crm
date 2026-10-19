// AssistGuard (019a, reference test/019a/assist.pg.test.ts: decision order, G4 / G6, F1 / F3 / F6 / F9). The real
// ConfirmationGate and LoopGuard run on a fake supabase-js client (test-fakes.ts); the SQL side (the consume writing
// its own ALLOW:CONFIRMED row, the cap, atomic transitions) is migration 120's and verify-assist-safety.sql's.
import { describe, expect, it, vi } from 'vitest';
import { actionHash } from './canonical';
import { LoopGuard } from './loop';
import type { AutonomyMode } from './registry';
import {
  ACCOUNT,
  FakeClock,
  NONCE,
  PENDING,
  USER,
  ctx,
  makeGuard,
  requestOk,
} from './test-fakes';

const MODES: AutonomyMode[] = ['supervised', 'cautious', 'autonomous'];

describe('AssistGuard decision order', () => {
  it('a rate refusal denies first: no loop admit, no pending row, audited', async () => {
    const loop = new LoopGuard();
    const admit = vi.spyOn(loop, 'admit');
    const { guard, db } = makeGuard({
      loop,
      rate: {
        allowed: false,
        reason: 'RATE_LIMITED',
        key: 'k',
        retryAfterMs: 1500,
      },
    });
    const d = await guard.check(ctx(), { tool: 'delete_contact', args: {} });
    expect(d).toEqual({
      kind: 'DENY',
      reason: 'RATE_LIMITED',
      retryAfterMs: 1500,
    });
    expect(admit).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
    expect(db.audits('decision')).toMatchObject([
      { outcome: 'DENY:RATE_LIMITED', account_id: ACCOUNT, user_id: USER },
    ]);
  });

  it('a rate store failure denies RATE_STATE_UNAVAILABLE; a malformed id (TypeError) denies BAD_REQUEST', async () => {
    const a = makeGuard({
      rate: { allowed: false, reason: 'RATE_STATE_UNAVAILABLE' },
    });
    expect(await a.guard.check(ctx(), { tool: 'get_contact' })).toEqual({
      kind: 'DENY',
      reason: 'RATE_STATE_UNAVAILABLE',
    });
    const b = makeGuard({
      rate: () => {
        throw new TypeError('bad id');
      },
    });
    expect(await b.guard.check(ctx(), { tool: 'get_contact' })).toEqual({
      kind: 'DENY',
      reason: 'BAD_REQUEST',
    });
    expect(b.db.audits('decision')[0]).toMatchObject({
      outcome: 'DENY:BAD_REQUEST',
    });
  });

  it('a loop-refused DANGEROUS call creates no pending row (CALL_CAP)', async () => {
    const { guard, db } = makeGuard({ loop: new LoopGuard({ maxCalls: 1 }) });
    await guard.check(ctx(), { tool: 'get_contact', args: { id: 1 } });
    const d = await guard.check(ctx(), { tool: 'delete_contact', args: {} });
    expect(d).toEqual({ kind: 'DENY', reason: 'CALL_CAP' });
    expect(db.rpcCalls('assist_pending_request')).toEqual([]);
    expect(db.audits('decision').map((r) => r.outcome)).toEqual([
      'ALLOW:ALLOWED',
      'DENY:CALL_CAP',
    ]);
  });

  it('LOOP_REPEAT: the third identical call is refused', async () => {
    const { guard } = makeGuard();
    const call = { tool: 'get_contact', args: { id: 7 } };
    expect((await guard.check(ctx(), call)).kind).toBe('ALLOW');
    expect((await guard.check(ctx(), call)).kind).toBe('ALLOW');
    expect(await guard.check(ctx(), call)).toEqual({
      kind: 'DENY',
      reason: 'LOOP_REPEAT',
    });
  });

  it('CIRCUIT_OPEN after three recorded errors, with retryAfterMs', async () => {
    const clock = new FakeClock();
    const { guard } = makeGuard({ loop: new LoopGuard({ clock }) });
    for (let i = 0; i < 3; i++) {
      const d = await guard.check(ctx(), {
        tool: 'get_contact',
        args: { id: i },
      });
      if (d.kind !== 'ALLOW') throw new Error('expected ALLOW');
      await guard.recordExecution(
        ctx(),
        { tool: 'get_contact', args: { id: i } },
        d,
        { error: new Error('x') }
      );
    }
    expect(
      await guard.check(ctx(), { tool: 'get_contact', args: { id: 9 } })
    ).toEqual({ kind: 'DENY', reason: 'CIRCUIT_OPEN', retryAfterMs: 1000 });
  });

  it('a tool the router has no handler for is DENY UNKNOWN_TOOL, audited and counted', async () => {
    const loop = new LoopGuard({ maxCalls: 1 });
    const { guard, db } = makeGuard({ loop });
    expect(
      await guard.check(ctx(), { tool: 'nope' }, { unknownTool: true })
    ).toEqual({ kind: 'DENY', reason: 'UNKNOWN_TOOL' });
    expect(db.audits('decision')[0]).toMatchObject({
      outcome: 'DENY:UNKNOWN_TOOL',
    });
    expect((await guard.check(ctx(), { tool: 'get_contact' })).kind).toBe(
      'DENY'
    );
  });

  it('non-JSON args deny BAD_REQUEST; absent args hash as {}', async () => {
    const { guard, db } = makeGuard();
    expect(
      await guard.check(ctx(), { tool: 'get_contact', args: { n: NaN } })
    ).toEqual({ kind: 'DENY', reason: 'BAD_REQUEST' });
    const d = await guard.check(ctx(), { tool: 'get_contact' });
    expect(d.kind).toBe('ALLOW');
    expect(db.audits('decision')[1]?.action_hash).toBe(
      actionHash('get_contact', {})
    );
  });
});

describe('AssistGuard risk x mode', () => {
  const expected: Record<string, Record<AutonomyMode, string>> = {
    get_contact: {
      supervised: 'ALLOW',
      cautious: 'ALLOW',
      autonomous: 'ALLOW',
    },
    update_contact: {
      supervised: 'NEEDS_CONFIRMATION',
      cautious: 'ALLOW',
      autonomous: 'ALLOW',
    },
    delete_contact: {
      supervised: 'NEEDS_CONFIRMATION',
      cautious: 'NEEDS_CONFIRMATION',
      autonomous: 'NEEDS_CONFIRMATION',
    },
    some_unregistered_tool: {
      supervised: 'NEEDS_CONFIRMATION',
      cautious: 'NEEDS_CONFIRMATION',
      autonomous: 'NEEDS_CONFIRMATION',
    },
  };
  for (const [tool, byMode] of Object.entries(expected))
    for (const mode of MODES)
      it(`${tool} in ${mode} -> ${byMode[mode]}`, async () => {
        const { guard, db } = makeGuard({
          script: { assist_pending_request: requestOk() },
        });
        const d = await guard.check(ctx({ mode }), { tool, args: { id: 1 } });
        expect(d.kind).toBe(byMode[mode]);
        const row = db.audits('decision')[0];
        expect(row).toMatchObject({
          kind: 'decision',
          actor: `assistant:${USER}`,
          run_id: 'run-1',
          tool,
          detail: { mode },
        });
        if (d.kind === 'NEEDS_CONFIRMATION') {
          expect(row).toMatchObject({
            outcome: 'NEEDS_CONFIRMATION',
            pending_id: PENDING,
          });
          expect(d.humanPrompt).toContain(NONCE);
        } else expect(row?.outcome).toBe('ALLOW:ALLOWED');
      });

  it('the default mode is cautious', async () => {
    const { guard } = makeGuard();
    expect((await guard.check(ctx(), { tool: 'update_contact' })).kind).toBe(
      'ALLOW'
    );
  });

  it('model arguments never approve anything: {confirm: true, approved: "yes"} still needs confirmation', async () => {
    const { guard, db } = makeGuard({
      script: { assist_pending_request: requestOk() },
    });
    const d = await guard.check(ctx({ mode: 'autonomous' }), {
      tool: 'delete_contact',
      args: { id: 1, confirm: true, approved: 'yes', ask_user: false },
    });
    expect(d.kind).toBe('NEEDS_CONFIRMATION');
    expect(db.rpcCalls('assist_pending_consume')).toEqual([]);
  });

  it('PENDING_CAP: the gate stores no row -> DENY PENDING_CAP, audited, nothing to cancel', async () => {
    const { guard, db } = makeGuard({
      script: { assist_pending_request: { data: [] } },
    });
    expect(await guard.check(ctx(), { tool: 'delete_contact' })).toEqual({
      kind: 'DENY',
      reason: 'PENDING_CAP',
    });
    expect(db.audits('decision')[0]?.outcome).toBe('DENY:PENDING_CAP');
    expect(db.rpcCalls('assist_pending_cancel')).toEqual([]);
  });

  it('a gate failure on request denies CONFIRM_STATE_UNAVAILABLE', async () => {
    const { guard } = makeGuard({
      script: { assist_pending_request: { error: { message: 'down' } } },
    });
    expect(await guard.check(ctx(), { tool: 'delete_contact' })).toEqual({
      kind: 'DENY',
      reason: 'CONFIRM_STATE_UNAVAILABLE',
    });
  });

  it('a NEEDS_CONFIRMATION whose decision audit fails is DENY AUDIT_UNAVAILABLE and its pending row is cancelled', async () => {
    const { guard, db } = makeGuard({
      script: {
        assist_pending_request: requestOk(),
        assist_pending_cancel: { data: true },
      },
    });
    db.failAudit = (r) => r.outcome === 'NEEDS_CONFIRMATION';
    expect(await guard.check(ctx(), { tool: 'delete_contact' })).toEqual({
      kind: 'DENY',
      reason: 'AUDIT_UNAVAILABLE',
    });
    expect(db.rpcCalls('assist_pending_cancel')).toEqual([
      { p_id: PENDING, p_reason: 'AUDIT_UNAVAILABLE' },
    ]);
  });

  it('any other decision audit failure denies AUDIT_UNAVAILABLE (fail closed)', async () => {
    const { guard, db } = makeGuard();
    db.failAudit = () => true;
    expect(await guard.check(ctx(), { tool: 'get_contact' })).toEqual({
      kind: 'DENY',
      reason: 'AUDIT_UNAVAILABLE',
    });
  });
});

describe('AssistGuard consume path', () => {
  const confirmed = {
    tool: 'delete_contact',
    args: { id: 1 },
    pendingId: PENDING,
  };

  it('a consume that moves the row is ALLOW CONFIRMED and writes no decision row of its own', async () => {
    const { guard, db } = makeGuard({
      script: { assist_pending_consume: { data: true } },
    });
    const d = await guard.check(ctx(), confirmed);
    expect(d).toMatchObject({ kind: 'ALLOW', reason: 'CONFIRMED' });
    expect(db.rpcCalls('assist_pending_consume')).toEqual([
      {
        p_id: PENDING,
        p_user: USER,
        p_account: ACCOUNT,
        p_action_hash: actionHash('delete_contact', { id: 1 }),
        p_actor: `assistant:${USER}`,
        p_run_id: 'run-1',
        p_tool: 'delete_contact',
        p_detail: { mode: 'cautious', risk: 'DANGEROUS' },
      },
    ]);
    // The SQL call wrote ALLOW:CONFIRMED; the guard must not append a duplicate.
    expect(db.audits()).toEqual([]);
  });

  it('a refused consume is audited DENY:<reason> by the guard', async () => {
    const { guard, db } = makeGuard({
      script: { assist_pending_consume: { data: false } },
    });
    db.pendingRow = {
      id: PENDING,
      user_id: USER,
      account_id: ACCOUNT,
      status: 'confirmed',
      action_hash: actionHash('delete_contact', { id: 2 }),
      expires_at: new Date(2_000_000_000_000).toISOString(),
    };
    expect(await guard.check(ctx(), confirmed)).toEqual({
      kind: 'DENY',
      reason: 'HASH_MISMATCH',
    });
    expect(db.audits('decision')).toMatchObject([
      { outcome: 'DENY:HASH_MISMATCH', pending_id: null },
    ]);
  });

  it('AUDIT_UNAVAILABLE on consume leaves the row confirmed; a retry executes once', async () => {
    const { guard, db } = makeGuard({
      script: {
        assist_pending_consume: [
          { error: { message: 'insert failed', hint: 'AUDIT_UNAVAILABLE' } },
          { data: true },
        ],
      },
    });
    expect(await guard.check(ctx(), confirmed)).toEqual({
      kind: 'DENY',
      reason: 'AUDIT_UNAVAILABLE',
    });
    // Nothing else was written or cancelled: the row stays confirmed for the retry.
    expect(db.audits()).toEqual([]);
    expect(db.rpcCalls('assist_pending_cancel')).toEqual([]);
    expect(await guard.check(ctx(), confirmed)).toMatchObject({
      kind: 'ALLOW',
      reason: 'CONFIRMED',
    });
    expect(db.rpcCalls('assist_pending_consume')).toHaveLength(2);
  });

  it('any other consume failure is audited DENY CONFIRM_STATE_UNAVAILABLE', async () => {
    const { guard, db } = makeGuard({
      script: { assist_pending_consume: { error: { message: 'down' } } },
    });
    expect(await guard.check(ctx(), confirmed)).toEqual({
      kind: 'DENY',
      reason: 'CONFIRM_STATE_UNAVAILABLE',
    });
    expect(db.audits('decision')[0]?.outcome).toBe(
      'DENY:CONFIRM_STATE_UNAVAILABLE'
    );
  });

  it('a pendingId on a call that needs no confirmation is ignored (no consume)', async () => {
    const { guard, db } = makeGuard();
    const d = await guard.check(ctx(), {
      tool: 'get_contact',
      pendingId: PENDING,
    });
    expect(d).toMatchObject({ kind: 'ALLOW', reason: 'ALLOWED' });
    expect(db.calls).toEqual([]);
  });

  it('a refused half-open trial is settled, so the breaker does not wedge', async () => {
    const clock = new FakeClock();
    const loop = new LoopGuard({ clock });
    const settle = vi.spyOn(loop, 'settle');
    const { guard } = makeGuard({
      loop,
      script: { assist_pending_request: requestOk() },
    });
    const d = await guard.check(ctx(), { tool: 'delete_contact' });
    expect(d.kind).toBe('NEEDS_CONFIRMATION');
    expect(settle).toHaveBeenCalledWith('run-1', 1);
  });
});

describe('AssistGuard.recordExecution', () => {
  it('audits executed_ok / executed_error with the error class only, never the message or args', async () => {
    const { guard, db } = makeGuard({
      script: { assist_pending_consume: { data: true } },
    });
    const call = {
      tool: 'delete_contact',
      args: { id: 1, secret: 'top-secret-arg' },
      pendingId: PENDING,
    };
    const d = await guard.check(ctx(), call);
    if (d.kind !== 'ALLOW') throw new Error('expected ALLOW');
    class ContactLockedError extends Error {}
    await guard.recordExecution(ctx(), call, d, {
      error: new ContactLockedError('message with top-secret-arg'),
    });
    await guard.recordExecution(ctx(), call, d);
    await guard.recordExecution(ctx(), call, d, { error: 'a string' });
    const rows = db.audits('execution');
    expect(rows).toMatchObject([
      {
        outcome: 'executed_error',
        pending_id: PENDING,
        detail: { decision: 'ALLOW:CONFIRMED', error: 'ContactLockedError' },
      },
      { outcome: 'executed_ok', detail: { decision: 'ALLOW:CONFIRMED' } },
      { outcome: 'executed_error', detail: { error: 'NonError' } },
    ]);
    expect(rows[1]?.detail).not.toHaveProperty('error');
    expect(JSON.stringify(rows)).not.toContain('top-secret-arg');
  });

  it('a failed execution-audit append is logged, never thrown', async () => {
    const warn = vi.fn();
    const { guard, db } = makeGuard({ logger: { warn } });
    const d = await guard.check(ctx(), { tool: 'get_contact' });
    if (d.kind !== 'ALLOW') throw new Error('expected ALLOW');
    db.failAudit = () => true;
    await expect(
      guard.recordExecution(ctx(), { tool: 'get_contact' }, d)
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'assist: execution audit append failed',
      expect.objectContaining({ outcome: 'executed_ok' })
    );
  });

  it('cancelPending swallows a gate failure', async () => {
    const warn = vi.fn();
    const { guard } = makeGuard({
      logger: { warn },
      script: { assist_pending_cancel: { error: { message: 'down' } } },
    });
    await expect(guard.cancelPending(PENDING, 'X')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'assist: pending cancel failed',
      expect.objectContaining({ pendingId: PENDING, reason: 'X' })
    );
  });
});
