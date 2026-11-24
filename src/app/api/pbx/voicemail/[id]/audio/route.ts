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

/** The PBX's time to send headers; a long message may stream longer. */
const HEADERS_TIMEOUT_MS = 10_000;

const notReturned = () =>
  fail('The phone system did not return the voicemail', 502);

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const own = await ownVoicemail(id);
    if ('refused' in own) return own.refused;
    const url = await own.api.voicemailDownloadUrl({
      msgId: own.message.msgId,
    });

    // Range is forwarded so the browser can seek; only a 206 is relayed
    // as one, anything else is the whole file as before.
    const range = request.headers.get('range');
    let upstream: Response;
    // One signal for both: the timer covers only the wait for headers,
    // the listener's leaving stops the download at any point (an aborted
    // fetch cancels its body too).
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, HEADERS_TIMEOUT_MS);
    const leave = () => abort.abort();
    if (request.signal.aborted) leave();
    else request.signal.addEventListener('abort', leave, { once: true });
    try {
      upstream = await fetch(url, {
        cache: 'no-store',
        redirect: 'error',
        signal: abort.signal,
        ...(range ? { headers: { Range: range } } : {}),
      });
    } catch {
      // The error may carry the URL, and with it the token: not logged.
      return timedOut
        ? fail('The phone system took too long to send the voicemail', 504)
        : notReturned();
    } finally {
      clearTimeout(timer);
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
    headers.set('Accept-Ranges', 'bytes');
    // fetch decompresses a content-encoded body but keeps the compressed
    // length, so Content-Length is trustworthy only without an encoding.
    const length = upstream.headers.get('content-length');
    const encoded = upstream.headers.get('content-encoding');
    if (length && !encoded && /^\d+$/.test(length))
      headers.set('Content-Length', length);
    const contentRange = upstream.headers.get('content-range');
    if (upstream.status === 206 && contentRange) {
      headers.set('Content-Range', contentRange);
      return new Response(upstream.body, { status: 206, headers });
    }
    return new Response(upstream.body, { status: 200, headers });
  } catch (err) {
    return pbxFailure(err) ?? toErrorResponse(err);
  }
}
