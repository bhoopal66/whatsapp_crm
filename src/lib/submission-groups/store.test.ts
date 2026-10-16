import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { SubmissionGroupDbError, SubmissionGroupStore } from './store';

const failing = (code: string | undefined) =>
  new SubmissionGroupStore({
    rpc: async () => ({ data: null, error: { message: 'boom', code } }),
  } as unknown as SupabaseClient);

describe('SubmissionGroupStore RPC errors', () => {
  it('carry the SQLSTATE so routes can tell an ended group apart', async () => {
    const err = await failing('55000')
      .accessSet('g', 'u', 'agent', null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionGroupDbError);
    expect((err as SubmissionGroupDbError).code).toBe('55000');
    expect((err as Error).message).toBe('sg_access_set: boom');
  });

  it('carry null when the driver gives no code', async () => {
    const err = await failing(undefined)
      .accessRemove('g', 'u')
      .catch((e: unknown) => e);
    expect((err as SubmissionGroupDbError).code).toBeNull();
  });
});
