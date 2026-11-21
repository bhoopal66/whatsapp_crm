import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: vi.fn() }));

import { reviewCase, runCaseReviewTick, type ReviewDeps } from './review';

const CASE = '11111111-1111-4111-8111-111111111111';
const ACC = '22222222-2222-4222-8222-222222222222';

function fakeDb(opts: { enabled?: boolean; model?: boolean } = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const tables: Record<string, unknown[]> = {
    case_documents: [{ doc_key: 'passport', status: 'received' }],
    case_document_files: [
      {
        id: 'f1',
        doc_key: 'passport',
        version: 1,
        status: 'passed',
        checks: [],
        expires_on: null,
        customer_document_id: 'd1',
      },
    ],
    customer_documents: [
      {
        id: 'd1',
        sha256: null,
        mime: 'application/pdf',
        storage_bucket: 'case-files',
        storage_path: 'p',
        media_url: null,
      },
    ],
  };
  const query = (table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      in: () => q,
      then: (res: (v: { data: unknown; error: null }) => unknown) =>
        res({ data: tables[table] ?? [], error: null }),
    };
    return q;
  };
  const db = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === 'case_review_settings')
        return {
          data: [
            {
              review_enabled: opts.enabled ?? true,
              review_send_to_model: opts.model ?? false,
            },
          ],
          error: null,
        };
      if (fn === 'case_file_spec_rows')
        return {
          data: [
            { doc_key: 'passport', position: 1, required: true },
            { doc_key: 'trade_licence', position: 2, required: true },
          ],
          error: null,
        };
      if (fn === 'case_review_draft_create')
        return { data: [{ draft_id: 'dr1', created: true }], error: null };
      if (fn === 'case_review_claim')
        return { data: [{ case_id: CASE, account_id: ACC }], error: null };
      return { data: null, error: null };
    }),
    from: (t: string) => query(t),
  };
  return { db, calls };
}

const deps = (db: unknown, over: Partial<ReviewDeps> = {}): ReviewDeps => ({
  db: db as never,
  storage: {} as never,
  now: () => new Date('2026-11-21T08:00:00Z'),
  readBytes: async () => new Uint8Array([1]),
  ...over,
});

const draftArgs = (
  calls: Array<{ fn: string; args: Record<string, unknown> }>
) =>
  calls.find((c) => c.fn === 'case_review_draft_create')!.args as {
    p_body: {
      narrative: string;
      flags: Array<{ code: string }>;
      checklist: Array<{ docKey: string; state: string }>;
    };
    p_source: string;
    p_input_hash: string;
  };

describe('reviewCase', () => {
  it('does nothing while the reviewer is off', async () => {
    const { db, calls } = fakeDb({ enabled: false });
    expect(await reviewCase(deps(db), CASE, ACC)).toEqual({
      ok: false,
      reason: 'off',
    });
    expect(calls.some((c) => c.fn === 'case_review_draft_create')).toBe(false);
  });

  it('writes the deterministic checklist without the model', async () => {
    const { db, calls } = fakeDb();
    const generate = vi.fn();
    const r = await reviewCase(deps(db, { generate }), CASE, ACC);
    expect(r).toMatchObject({ ok: true, narrativeSource: 'deterministic' });
    const a = draftArgs(calls);
    expect(a.p_body.checklist.map((i) => [i.docKey, i.state])).toEqual([
      ['passport', 'received'],
      ['trade_licence', 'missing'],
    ]);
    expect(a.p_body.narrative).toMatch(/^1 of 2 required documents received/);
    expect(a.p_input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generate).not.toHaveBeenCalled();
  });

  it('sends redacted text to the model for the narrative', async () => {
    const { db, calls } = fakeDb({ model: true });
    const generate = vi.fn(async () => ({
      text: 'Passport present; trade licence missing.',
      handoff: false,
      usage: null,
    }));
    const r = await reviewCase(
      deps(db, {
        loadConfig: async () =>
          ({ provider: 'openai', model: 'm', accountId: ACC }) as never,
        extract: async () => ({
          ok: true,
          text: 'Name AHMED, ID 784-1987-1234567-1 issued Dubai',
        }),
        generate: generate as never,
      }),
      CASE,
      ACC
    );
    expect(r).toMatchObject({ ok: true, narrativeSource: 'model' });
    const sent = (generate.mock.calls[0] as unknown[])[0] as {
      purpose: string;
      messages: Array<{ content: string }>;
    };
    expect(sent.purpose).toBe('case_review');
    expect(sent.messages[0]!.content).not.toContain('784-1987-1234567-1');
    expect(draftArgs(calls).p_body.narrative).toBe(
      'Passport present; trade licence missing.'
    );
  });

  it('flags a scan for a person and falls back on a model failure', async () => {
    const { db, calls } = fakeDb({ model: true });
    const r = await reviewCase(
      deps(db, {
        loadConfig: async () =>
          ({ provider: 'openai', model: 'm', accountId: ACC }) as never,
        extract: async () => ({ ok: false, reason: 'scanned' }),
        generate: (async () => {
          throw new Error('transfer_basis_required');
        }) as never,
      }),
      CASE,
      ACC
    );
    expect(r).toMatchObject({ ok: true, narrativeSource: 'deterministic' });
    expect(draftArgs(calls).p_body.flags.map((f) => f.code)).toEqual([
      'NEEDS_MANUAL_REVIEW',
      'MODEL_ERROR',
    ]);
  });

  it('says so when the model is on but no AI key is configured', async () => {
    const { db, calls } = fakeDb({ model: true });
    await reviewCase(deps(db, { loadConfig: async () => null }), CASE, ACC);
    expect(draftArgs(calls).p_body.flags.map((f) => f.code)).toEqual([
      'MODEL_NOT_CONFIGURED',
    ]);
  });
});

describe('runCaseReviewTick', () => {
  it('reviews each claimed case and settles it', async () => {
    const { db, calls } = fakeDb();
    expect(await runCaseReviewTick(deps(db))).toEqual({
      claimed: 1,
      drafted: 1,
      failed: 0,
    });
    expect(calls.find((c) => c.fn === 'case_review_finish')!.args).toEqual({
      p_case: CASE,
      p_ok: true,
      p_error: null,
    });
  });
});
