import type { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { pbxServiceDb } from '@/lib/pbx/admin';
import { fail, myExtension, noExtension } from '@/lib/pbx/calls';
import { pbxApiFor } from '@/lib/pbx/connection';
import { isVoicemailId } from '@/lib/pbx/voicemail';
import { findOwnVoicemail } from '@/lib/pbx/voicemail-server';
import type { VoicemailMessage, YeastarApi } from '@/lib/pbx/yeastar';

/**
 * The message `id` from the caller's OWN box (agent and up), with the
 * PBX api to act on it, or the response refusing: 409 with no
 * extension, 404 for an id the caller's box does not list. Throws what
 * requireRole and the PBX throw, for the route's catch.
 */
export async function ownVoicemail(
  id: string
): Promise<
  { api: YeastarApi; message: VoicemailMessage } | { refused: NextResponse }
> {
  const ctx = await requireRole('agent');
  const ext = await myExtension(ctx.supabase);
  if (!ext) return { refused: noExtension() };
  const notFound = { refused: fail('Voicemail not found', 404) };
  if (!isVoicemailId(id)) return notFound;
  const { api } = await pbxApiFor(pbxServiceDb(), ext.connectionId);
  const message = await findOwnVoicemail(api, ext.extension, id);
  return message ? { api, message } : notFound;
}
