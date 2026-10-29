import { createHash } from 'node:crypto';
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
import { TRANSLATE_MAX_CHARS } from '@/lib/translate/draft';

/**
 * POST /api/ai/translate/message  (viewer+)
 *
 * Body: { message_id }
 * Returns: { text, cached } — the stored message in English.
 *
 * A reading aid, so viewers may use it (bank guests rank below viewer).
 * The text translated is the stored message, read through the caller's
 * RLS client, never text from the browser. Translations are kept in
 * message_translations (migration 154, service role only) keyed by
 * message and a hash of the text, so an edited message is translated
 * afresh and a repeat click spends nothing on the account's key.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('viewer');

    const userLimit = checkRateLimit(
      `ai-translate:${userId}`,
      RATE_LIMITS.aiTranslate
    );
    if (!userLimit.success) return rateLimitResponse(userLimit);

    const body = await request.json().catch(() => null);
    const messageId = body && typeof body === 'object' ? body.message_id : null;
    if (!isUuid(messageId)) {
      return NextResponse.json(
        { error: 'message_id must be a message id.', code: 'invalid_request' },
        { status: 400 }
      );
    }

    // RLS decides visibility. The account check matters because this
    // route spends `accountId`'s key: a message from elsewhere is 404.
    const { data: message, error: msgErr } = await supabase
      .from('messages')
      .select(
        'id, conversation_id, content_text, conversations!inner(account_id)'
      )
      .eq('id', messageId)
      .maybeSingle();
    if (msgErr) {
      console.error(
        '[ai/translate/message] message lookup error:',
        msgErr.message
      );
      return NextResponse.json(
        { error: 'Failed to load message' },
        { status: 500 }
      );
    }
    const embedded: unknown = message?.conversations;
    const conv = (Array.isArray(embedded) ? embedded[0] : embedded) as
      { account_id?: string } | null | undefined;
    if (!message || conv?.account_id !== accountId) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    const source =
      typeof message.content_text === 'string' ? message.content_text : '';
    if (!source.trim()) {
      return NextResponse.json(
        {
          error: 'This message has no text to translate.',
          code: 'nothing_to_translate',
        },
        { status: 400 }
      );
    }
    if (source.length > TRANSLATE_MAX_CHARS) {
      return NextResponse.json(
        { error: 'This message is too long to translate.', code: 'too_long' },
        { status: 400 }
      );
    }

    const sourceHash = createHash('sha256')
      .update(source, 'utf8')
      .digest('hex');
    const admin = supabaseAdmin();

    // A failed cache read is a miss: the agent still gets a translation.
    const { data: cachedRow, error: cacheErr } = await admin
      .from('message_translations')
      .select('source_hash, translated_text')
      .eq('message_id', message.id)
      .eq('lang', 'en')
      .maybeSingle();
    if (cacheErr) {
      console.error(
        '[ai/translate/message] cache read failed:',
        cacheErr.message
      );
    } else if (
      cachedRow &&
      cachedRow.source_hash === sourceHash &&
      typeof cachedRow.translated_text === 'string' &&
      cachedRow.translated_text
    ) {
      return NextResponse.json({
        text: cachedRow.translated_text,
        cached: true,
      });
    }

    // Caps the whole team's draws on the shared BYO key. Cache hits above
    // spend nothing, so they never count here.
    const accountLimit = checkRateLimit(
      `ai-translate-acct:${accountId}`,
      RATE_LIMITS.aiTranslateAccount
    );
    if (!accountLimit.success) return rateLimitResponse(accountLimit);

    // ai_configs is admin-only under RLS (057): service-role read scoped
    // to the account requireRole resolved. The default requireActive
    // means the AI master switch turns Translate off too.
    const config = await loadAiConfig(admin, accountId).catch((err) => {
      console.error('[ai/translate/message] loadAiConfig error:', err);
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      });
    });
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

    const { text, model, usage } = await translateText({
      config,
      text: source,
      target: 'en',
    });

    // 154's trigger overwrites account_id and conversation_id from the
    // message; they are sent only because the columns are NOT NULL.
    const { error: writeErr } = await admin.from('message_translations').upsert(
      {
        message_id: message.id,
        lang: 'en',
        source_hash: sourceHash,
        translated_text: text,
        provider: config.provider,
        model,
        account_id: accountId,
        conversation_id: message.conversation_id,
      },
      { onConflict: 'message_id,lang' }
    );
    if (writeErr) {
      console.error(
        '[ai/translate/message] cache write failed:',
        writeErr.message
      );
    }

    // Best-effort and not awaited, as in the draft route.
    try {
      void logAiUsage(supabaseAdmin(), {
        accountId,
        conversationId: message.conversation_id,
        mode: 'translate',
        provider: config.provider,
        model,
        usage,
      });
    } catch (logErr) {
      console.error('[ai/translate/message] usage log skipped:', logErr);
    }

    return NextResponse.json({ text, cached: false });
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
