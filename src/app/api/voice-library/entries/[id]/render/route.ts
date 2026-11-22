import { NextResponse } from 'next/server';

import { AiError } from '@/lib/ai/types';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isUuid } from '@/lib/coordinators/errors';
import { STAGED_MEDIA_SUBFOLDER } from '@/lib/storage/staged-media';
import { buildMediaPath } from '@/lib/storage/upload-media';
import {
  DEFAULT_TTS_VOICE,
  isTtsVoice,
  isVoiceLanguage,
} from '@/lib/voice-library/constants';
import { fillScript } from '@/lib/voice-library/script';
import {
  loadTtsKey,
  storeVoiceAudio,
  voiceTtsLimited,
} from '@/lib/voice-library/server';
import { synthesizeSpeech } from '@/lib/voice-library/tts';

export const maxDuration = 60;

/**
 * POST /api/voice-library/entries/[id]/render  (agent and up)
 *
 * Body: { conversation_id }. Speaks a personalised entry for this chat's
 * customer ({name}, {company} from the contact the caller can see) and
 * returns `{ mediaUrl, path }`, which the composer then sends through
 * the ordinary send route like its own recorded voice note. Nothing is
 * sent here.
 *
 * The audio goes under `staged/` like any composer attachment: once sent,
 * the message's media_url keeps it (155's sweep skips referenced
 * objects); never sent, the sweep deletes it after 30 days, and a failed
 * send's GC removes it sooner. The customer's name never lands in the
 * library folder.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const { id } = await params;
    const body: unknown = await request.json().catch(() => null);
    const conversationId =
      body && typeof body === 'object'
        ? (body as Record<string, unknown>).conversation_id
        : null;
    if (!isUuid(id) || !isUuid(conversationId)) {
      return NextResponse.json(
        { error: 'Send conversation_id.', code: 'invalid_request' },
        { status: 400 }
      );
    }

    const { data: entry, error: entryErr } = await supabase
      .from('voice_note_entries')
      .select('id, language, script, personalised, voice')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (entryErr) throw entryErr;
    if (!entry || !entry.personalised || !entry.script) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (!isVoiceLanguage(entry.language)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Through the caller's client: a chat they cannot see answers 404,
    // and its customer's name is never spoken for them.
    const { data: conversation, error: convErr } = await supabase
      .from('conversations')
      .select('id, account_id, contact:contacts(name, company)')
      .eq('id', conversationId)
      .maybeSingle();
    if (convErr) throw convErr;
    if (!conversation || conversation.account_id !== accountId) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }
    const contactRaw = (conversation as { contact?: unknown }).contact;
    const contact = (Array.isArray(contactRaw) ? contactRaw[0] : contactRaw) as
      { name?: string | null; company?: string | null } | null | undefined;

    const limited = voiceTtsLimited(userId, accountId);
    if (limited) return limited;
    const key = await loadTtsKey(accountId);
    if (!key.ok) {
      return NextResponse.json(
        { error: 'AI speech is not available.', code: key.reason },
        { status: 400 }
      );
    }

    const text = fillScript(
      entry.script,
      { name: contact?.name ?? null, company: contact?.company ?? null },
      entry.language
    );
    const bytes = await synthesizeSpeech({
      accountId,
      apiKey: key.apiKey,
      text,
      voice: isTtsVoice(entry.voice) ? entry.voice : DEFAULT_TTS_VOICE,
      language: entry.language,
    });

    const path = buildMediaPath(
      accountId,
      `voice-note.ogg`,
      Date.now(),
      STAGED_MEDIA_SUBFOLDER
    );
    const mediaUrl = await storeVoiceAudio(supabase, path, bytes);
    return NextResponse.json({ mediaUrl, path });
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
