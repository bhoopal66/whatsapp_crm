/**
 * Server wiring of `ChatAssistBrainPort` (`brain.ts`): the same pieces
 * the /api/brain routes use, with the account and the actor from the
 * session. Brain text (a query, a remembered note) is never logged.
 */
import type { AccountContext } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { ingestRemember } from '@/lib/brain/ingest';
import { searchBrain } from '@/lib/brain/search';
import { brainDeps, brainEnabled, brainPages } from '@/lib/brain/server';
import { markPagesDirty } from '@/lib/brain/sink';
import { RateLimiter, RpcRateStore } from '@/lib/edge';
import { assertAiTransfer } from '@/lib/privacy/ai-transfer';
import { supabaseAdmin } from '@/lib/submission-groups/server';

import type { ChatAssistBrainPort } from './brain';

/** At most this many hits go to the model (the route allows 20). */
export const CHAT_ASSIST_BRAIN_HITS = 6;

export function chatAssistBrainPort(
  ctx: Pick<
    AccountContext,
    'accountId' | 'userId' | 'role' | 'salesRestricted'
  >,
  /** The workspace's AI config: the provider the brain text would go to. */
  ai: { provider: string; model: string | null } | null
): ChatAssistBrainPort {
  const { accountId, userId } = ctx;
  return {
    access: !ctx.salesRestricted && hasMinRole(ctx.role, 'agent'),
    enabled: () => brainEnabled(accountId),
    transfer: async (purpose, bytes) => {
      if (!ai) throw new Error('no AI config');
      await assertAiTransfer(
        { accountId, provider: ai.provider },
        purpose,
        ai.model,
        bytes
      );
    },
    searchAllowed: async () =>
      (
        await new RateLimiter(new RpcRateStore(supabaseAdmin())).check(
          'brain.search',
          `${accountId}:${userId}`
        )
      ).allowed,
    search: (query) =>
      searchBrain(brainDeps(), {
        actorId: userId,
        accountId,
        query,
        limit: CHAT_ASSIST_BRAIN_HITS,
      }),
    remember: async (text, contactId) => {
      const r = await ingestRemember(brainDeps(), userId, text, {
        accountId,
        caseId: null,
        contactId,
        // The model proposed it; the person confirmed it.
        aiGenerated: true,
      });
      if (!r.ok) return { ok: false };
      await markPagesDirty(brainPages(), accountId, r.itemIds);
      return { ok: true, itemIds: r.itemIds };
    },
  };
}
