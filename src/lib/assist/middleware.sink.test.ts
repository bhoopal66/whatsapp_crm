// The wacrm replacement for the reference's test/019e/audit.pg.test.ts and test/019f/audit.pg.test.ts (vitest has no
// database): the row supabaseAgentRunAuditSink writes, on a fake client. What the database does with it (the 132 kind
// CHECK, append-only, service_role grant) is asserted in supabase/ci/verify-assistant-safety.sql.
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect } from 'vitest';
import {
  auditAfterAgent,
  supabaseAgentRunAuditSink,
  type AgentRunAuditRow,
} from './middleware.builtin';
import { runAgent } from './middleware';
import { promptCacheMiddleware } from './promptcache';
import { ACCOUNT, FakeDb, USER } from './test-fakes';

const row = (runId: string): AgentRunAuditRow => ({
  kind: 'agent_run',
  runId,
  userId: USER,
  workspaceId: ACCOUNT,
  channel: 'whatsapp',
  outcome: 'completed',
  detail: {
    rounds: 2,
    toolsProposed: 3,
    toolsAllowed: 1,
    toolsRefused: 1,
    toolsPending: 1,
  },
});

describe('supabaseAgentRunAuditSink', () => {
  it('inserts one agent_run row into assist_audit, counts only, channel in detail', async () => {
    const db = new FakeDb();
    await supabaseAgentRunAuditSink(db as unknown as SupabaseClient)(
      row('run-1')
    );
    expect(db.inserts).toEqual([
      {
        table: 'assist_audit',
        row: {
          kind: 'agent_run',
          actor: 'system:assist',
          account_id: ACCOUNT,
          user_id: USER,
          run_id: 'run-1',
          outcome: 'completed',
          detail: {
            rounds: 2,
            toolsProposed: 3,
            toolsAllowed: 1,
            toolsRefused: 1,
            toolsPending: 1,
            channel: 'whatsapp',
          },
        },
      },
    ]);
    expect(db.calls).toEqual([]);
  });

  it('throws on an insert error, naming the SQLSTATE but not the PostgREST message', async () => {
    const db = new FakeDb();
    db.failAudit = () => true;
    const client = db as unknown as SupabaseClient;
    await expect(
      supabaseAgentRunAuditSink(client)(row('run-1'))
    ).rejects.toThrow(/^assist_audit agent_run insert failed$/);
    const coded = {
      from: () => ({
        insert: async () => ({
          error: { message: 'row data 0501234567', code: '23514' },
        }),
      }),
    };
    const err = await supabaseAgentRunAuditSink(
      coded as unknown as SupabaseClient
    )(row('run-1')).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      'assist_audit agent_run insert failed (23514)'
    );
    expect((err as Error).message).not.toMatch(/0501234567/);
  });

  it('carries the 019f cache counts in detail through pc.auditSink, counts only', async () => {
    const db = new FakeDb();
    const pc = promptCacheMiddleware({
      constants: { 'sys.core': 'You are the CRM assistant.' },
      staticIds: ['sys.core'],
      tools: [],
    });
    const model = async () => ({
      text: 'done',
      toolCalls: [],
      usage: { cacheReadTokens: 11, cacheWriteTokens: 5 },
    });
    const router = {
      execute: async () => ({ status: 'ok' as const, result: null }),
    };
    await runAgent(
      { model: pc.wrapModel(model), router },
      [
        pc,
        auditAfterAgent(
          pc.auditSink(
            supabaseAgentRunAuditSink(db as unknown as SupabaseClient)
          )
        ),
      ],
      {
        runId: 'run-c',
        userId: USER,
        workspaceId: ACCOUNT,
        channel: 'whatsapp',
        messages: [{ role: 'user', content: 'hello' }],
      }
    );
    expect(db.audits('agent_run')).toHaveLength(1);
    expect(db.audits('agent_run')[0]!.detail).toEqual({
      rounds: 1,
      toolsProposed: 0,
      toolsAllowed: 0,
      toolsRefused: 0,
      toolsPending: 0,
      cache_read_tokens: 11,
      cache_write_tokens: 5,
      channel: 'whatsapp',
    });
    expect(JSON.stringify(db.inserts)).not.toMatch(/CRM assistant|hello/);
  });
});
