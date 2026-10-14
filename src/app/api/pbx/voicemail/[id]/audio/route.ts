// ============================================================
// GET /api/pbx/voicemail/[id]/audio — the message's audio, streamed
// through the CRM.
//
// The id is acted on only once the caller's own extension's vm/get
// lists it (ownVoicemail); any other id is a 404. vm/download's link
// embeds a live PBX token, so it is fetched here and never returned,
// logged or stored: the browser only ever sees this route. Playing does
// not mark the message read; the panel posts /read for that. Agent+.
// ============================================================

import { toErrorResponse } from '@/lib/auth/account';
import { fail, pbxFailure } from '@/lib/pbx/calls';
import { voicemailAudioType } from '@/lib/pbx/voicemail-server';
import { ownVoicemail } from '../own';

const notReturned = () =>
  fail('The phone system did not return the voicemail', 502);

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const own = await ownVoicemail(id);
    if ('refused' in own) return own.refused;
    const url = await own.api.voicemailDownloadUrl({
      msgId: own.message.msgId,
    });

    let upstream: Response;
    try {
      upstream = await fetch(url, { cache: 'no-store', redirect: 'error' });
    } catch {
      // The error may carry the URL, and with it the token: not logged.
      return notReturned();
    }
    const sent = upstream.headers.get('content-type');
    // A JSON body where audio should be is the PBX's error envelope.
    if (!upstream.ok || !upstream.body || (sent ?? '').includes('json')) {
      await upstream.body?.cancel().catch(() => undefined);
      return notReturned();
    }
    const headers = new Headers({
      'Content-Type': voicemailAudioType(own.message.fileName, sent),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const length = upstream.headers.get('content-length');
    if (length && /^\d+$/.test(length)) headers.set('Content-Length', length);
    return new Response(upstream.body, { status: 200, headers });
  } catch (err) {
    return pbxFailure(err) ?? toErrorResponse(err);
  }
}
