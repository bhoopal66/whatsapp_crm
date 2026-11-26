import { describe, expect, it } from 'vitest';

import type { SupabaseClient } from '@supabase/supabase-js';

import { classifySendFailure } from './failure';
import type { TemplateSendRequest } from './ports';
import { RcsSendError } from './rcs';
import { recipientNumber } from './recipient';

const REQ = {
  accountId: 'acc-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
} as TemplateSendRequest;

function ask(refused: string | null, conv: Record<string, unknown> | null) {
  const db = {
    from(table: string) {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => {
          if (table === refused)
            return { data: null, error: { code: '57014' } };
          return {
            data: table === 'conversations' ? conv : { phone: '+971501234567' },
            error: null,
          };
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return recipientNumber(
    db,
    REQ,
    (reason, retryable) => new RcsSendError(reason, retryable)
  );
}

const CONV = { contact_id: 'contact-1', personal_owner_id: null };
const failure = (p: Promise<string>) =>
  p.then(
    () => null,
    (e: unknown) => classifySendFailure(e)
  );

describe('recipientNumber', () => {
  it.each(['conversations', 'contacts'])(
    'a failed read of %s is worth another try',
    async (table) => {
      expect(await failure(ask(table, CONV))).toEqual({
        retryable: true,
        reason: 'database_error',
      });
    }
  );

  it('a chat that is not there is refused for good', async () => {
    expect(await failure(ask(null, null))).toEqual({
      retryable: false,
      reason: 'conversation_missing',
    });
    expect(await ask(null, CONV)).toBe('971501234567');
  });
});
