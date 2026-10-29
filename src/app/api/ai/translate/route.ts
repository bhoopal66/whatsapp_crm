import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { loadAiConfig } from '@/lib/ai/config';
import { translateText } from '@/lib/ai/translate';
import { logAiUsage } from '@/lib/ai/usage';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { AiError } from '@/lib/ai/types';
import { isUuid } from '@/lib/coordinators/errors';
import { TRANSLATE_MAX_CHARS } from '@/lib/translate/limits';

/**
 * POST /api/ai/translate  (agent+)
 *
 * Body: { text, conversation_id, target: 'ar' }
 * Returns: { text } — the composer's draft in Arabic, for the agent to
 * review and send. Nothing is sent or stored. The conversation proves
 * the caller works that thread and names the usage log row.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const userLimit = checkRateLimit(
      `ai-translate:${userId}`,
      RATE_LIMITS.aiTranslate
    );
    if (!userLimit.success) return rateLimitResponse(userLimit);

    const body: unknown = await request.json().catch(() => null);
    const obj =
      body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const { text, conversation_id: conversationId, target } = obj;
    if (
      target !== 'ar' ||
      typeof text !== 'string' ||
      !text.trim() ||
      !isUuid(conversationId)
    ) {
      return NextResponse.json(
        {
          error: 'Send text, conversation_id and target "ar".',
          code: 'invalid_request',
        },
        { status: 400 }
      );
    }
    if (text.length > TRANSLATE_MAX_CHARS) {
      return NextResponse.json(
        { error: 'This message is too long to translate.', code: 'too_long' },
        { status: 400 }
      );
    }

    const { data: conversation, error: convErr } = await supabase
      .from('conversations')
      .select('id, account_id')
      .eq('id', conversationId)
      .maybeSingle();
    if (convErr) {
      console.error(
        '[ai/translate] conversation lookup error:',
        convErr.message
      );
      return NextResponse.json(
        { error: 'Failed to load conversation' },
        { status: 500 }
      );
    }
    if (!conversation || conversation.account_id !== accountId) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const accountLimit = checkRateLimit(
      `ai-translate-acct:${accountId}`,
      RATE_LIMITS.aiTranslateAccount
    );
    if (!accountLimit.success) return rateLimitResponse(accountLimit);

    const config = await loadAiConfig(supabaseAdmin(), accountId).catch(
      (err) => {
        console.error('[ai/translate] loadAiConfig error:', err);
        throw new AiError('Stored API key could not be decrypted.', {
          code: 'key_decrypt_failed',
          status: 400,
        });
      }
    );
    if (!config) {
      return NextResponse.json(
        {
          error:
            'AI assistant is not set up. Enable it in AI Agents → Assistant.',
          code: 'ai_not_configured',
        },
        { status: 400 }
      );
    }

    const result = await translateText({ config, text, target: 'ar' });

    try {
      void logAiUsage(supabaseAdmin(), {
        accountId,
        conversationId,
        mode: 'translate',
        provider: config.provider,
        model: result.model,
        usage: result.usage,
      });
    } catch (logErr) {
      console.error('[ai/translate] usage log skipped:', logErr);
    }

    return NextResponse.json({ text: result.text });
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    return toErrorResponse(err);
  }
}
