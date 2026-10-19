// createModelToolRouter (019a, reference G4 / F3 / F5 / F9): the model gets a pendingId, never the prompt or nonce.
import { describe, expect, it, vi } from 'vitest';
import { LoopGuard } from './loop';
import { createModelToolRouter, type ToolHandler } from './router';
import {
  NONCE,
  PENDING,
  ctx,
  makeGuard,
  requestOk,
  type Answer,
} from './test-fakes';

function setup(
  script: Record<string, Answer | Answer[]> = {},
  handlers: Record<string, ToolHandler> = {},
  loop?: LoopGuard
) {
  const g = makeGuard({ script, ...(loop ? { loop } : {}) });
  const notify = vi.fn<
    (c: unknown, id: string, prompt: string) => Promise<void>
  >(async () => {});
  const router = createModelToolRouter(g.guard, handlers, notify);
  return { ...g, router, notify };
}

describe('model tool router', () => {
  it('exposes execute only (no confirm / deny / consume)', () => {
    const { router } = setup();
    expect(Object.keys(router)).toEqual(['execute']);
    expect(Object.isFrozen(router)).toBe(true);
  });

  it('NEEDS_CONFIRMATION: the model gets the pendingId only; the prompt with the nonce goes to notifyHuman', async () => {
    const del = vi.fn(async () => 'deleted');
    const { router, notify } = setup(
      { assist_pending_request: requestOk() },
      { delete_contact: del }
    );
    const r = await router.execute(ctx(), {
      tool: 'delete_contact',
      args: { id: 1, confirm: true },
    });
    expect(r).toEqual({ status: 'needs_confirmation', pendingId: PENDING });
    expect(JSON.stringify(r)).not.toContain(NONCE);
    expect(del).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[1]).toBe(PENDING);
    expect(String(notify.mock.calls[0]?.[2])).toContain(NONCE);
  });

  it('a notifyHuman failure cancels the pending row with NOTIFY_FAILED and executes nothing', async () => {
    const del = vi.fn(async () => 'deleted');
    const { router, notify, db } = setup(
      {
        assist_pending_request: requestOk(),
        assist_pending_cancel: { data: true },
      },
      { delete_contact: del }
    );
    notify.mockRejectedValueOnce(new Error('channel down'));
    expect(await router.execute(ctx(), { tool: 'delete_contact' })).toEqual({
      status: 'denied',
      reason: 'NOTIFY_FAILED',
    });
    expect(db.rpcCalls('assist_pending_cancel')).toEqual([
      { p_id: PENDING, p_reason: 'NOTIFY_FAILED' },
    ]);
    expect(del).not.toHaveBeenCalled();
  });

  it('runs an allowed handler with {} for absent args and audits executed_ok', async () => {
    const get = vi.fn(async () => ({ name: 'Jane' }));
    const { router, db } = setup({}, { get_contact: get });
    expect(await router.execute(ctx(), { tool: 'get_contact' })).toEqual({
      status: 'ok',
      result: { name: 'Jane' },
    });
    expect(get).toHaveBeenCalledWith({}, ctx());
    expect(db.audits('execution')[0]?.outcome).toBe('executed_ok');
  });

  it('a handler failure returns error, audits the class only and feeds the loop breaker', async () => {
    const loop = new LoopGuard();
    const record = vi.spyOn(loop, 'record');
    const { router, db } = setup(
      {},
      {
        get_contact: async () => {
          throw new RangeError('boom');
        },
      },
      loop
    );
    expect(await router.execute(ctx(), { tool: 'get_contact' })).toEqual({
      status: 'error',
      message: 'boom',
    });
    expect(record).toHaveBeenCalledWith('run-1', 1, 'error');
    expect(db.audits('execution')[0]).toMatchObject({
      outcome: 'executed_error',
      detail: { error: 'RangeError' },
    });
  });

  it('a handler failing after a consume leaves it consumed: the re-issue is not retried silently', async () => {
    const { router, db } = setup(
      { assist_pending_consume: [{ data: true }, { data: false }] },
      {
        delete_contact: async () => {
          throw new Error('x');
        },
      }
    );
    db.pendingRow = {
      id: PENDING,
      user_id: ctx().userId,
      account_id: ctx().workspaceId,
      status: 'consumed',
      action_hash: 'h',
      expires_at: new Date(2_000_000_000_000).toISOString(),
    };
    const call = { tool: 'delete_contact', pendingId: PENDING };
    expect((await router.execute(ctx(), call)).status).toBe('error');
    expect(await router.execute(ctx(), call)).toEqual({
      status: 'denied',
      reason: 'NOT_PENDING',
    });
  });

  it('an unknown tool is denied UNKNOWN_TOOL through the guard (audited)', async () => {
    const { router, db } = setup({}, {});
    expect(await router.execute(ctx(), { tool: 'toString' })).toEqual({
      status: 'denied',
      reason: 'UNKNOWN_TOOL',
    });
    expect(db.audits('decision')[0]?.outcome).toBe('DENY:UNKNOWN_TOOL');
  });

  it('CALL_CAP, LOOP_REPEAT and CIRCUIT_OPEN come through as denials', async () => {
    let fail = true;
    const { router } = setup(
      {},
      {
        get_contact: async () => {
          if (fail) throw new Error('x');
          return 1;
        },
        search_contacts: async () => [],
      },
      new LoopGuard({ maxCalls: 6 })
    );
    const c = ctx();
    expect((await router.execute(c, { tool: 'search_contacts' })).status).toBe(
      'ok'
    );
    expect((await router.execute(c, { tool: 'search_contacts' })).status).toBe(
      'ok'
    );
    expect(await router.execute(c, { tool: 'search_contacts' })).toEqual({
      status: 'denied',
      reason: 'LOOP_REPEAT',
    });
    for (let i = 0; i < 3; i++)
      expect(
        (await router.execute(c, { tool: 'get_contact', args: { i } })).status
      ).toBe('error');
    fail = false;
    // 7th call: over the cap of 6, which is checked before the breaker.
    expect(
      await router.execute(c, { tool: 'get_contact', args: { i: 9 } })
    ).toEqual({ status: 'denied', reason: 'CALL_CAP' });
    const open = await router.execute(ctx({ runId: 'run-2' }), {
      tool: 'get_contact',
    });
    expect(open.status).toBe('ok');
  });

  it('CIRCUIT_OPEN carries retryAfterMs', async () => {
    const { router } = setup(
      {},
      {
        get_contact: async () => {
          throw new Error('x');
        },
      }
    );
    for (let i = 0; i < 3; i++)
      await router.execute(ctx(), { tool: 'get_contact', args: { i } });
    const r = await router.execute(ctx(), {
      tool: 'get_contact',
      args: { i: 4 },
    });
    expect(r).toMatchObject({ status: 'denied', reason: 'CIRCUIT_OPEN' });
    expect((r as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThan(0);
  });
});
