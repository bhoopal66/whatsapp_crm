import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  signChatMediaPath,
  VIEWER_LINK_TTL_SECONDS,
} from '@/lib/storage/chat-media-sign';
import { isSafeChatMediaPath } from '@/lib/storage/chat-media-url';

type Params = { params: Promise<{ path: string[] }> };

const notFound = () =>
  NextResponse.json({ error: 'Not found' }, { status: 404 });

/**
 * GET /api/media/chat/<object path>  (staff of the workspace)
 *
 * chat-media is private (migration 321): a stored attachment link no
 * longer opens on its own. Screens render this route instead
 * (`chatMediaDisplayUrl`), which checks the signed-in caller is staff of
 * the workspace that owns the object (its first folder is
 * `account-<active workspace id>`; a bank guest is refused) and
 * redirects to a signed link valid for five minutes. Another workspace's
 * object and a missing one answer the same 404.
 *
 * Who of the workspace may open which file is not narrowed further: an
 * object path does not name its chat. The names carry the provider's
 * random media id, so they cannot be guessed, and before 321 anyone on
 * the internet holding one could open the file forever.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('viewer');
    const limit = checkRateLimit(
      `chat-media:${ctx.userId}`,
      RATE_LIMITS.mediaView
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { path: segments } = await params;
    const path = (segments ?? []).join('/');
    if (!isSafeChatMediaPath(path)) return notFound();
    if (!path.startsWith(`account-${ctx.accountId}/`)) return notFound();

    // `?download=<name>`: a download button's file name, at most 200
    // plain characters (it becomes a Content-Disposition name).
    const raw = new URL(request.url).searchParams.get('download');
    const download =
      raw && raw.length <= 200 && !/[\u0000-\u001f"\\]/.test(raw)
        ? raw
        : undefined;
    const signed = await signChatMediaPath(
      path,
      VIEWER_LINK_TTL_SECONDS,
      undefined,
      download
    );
    if (!signed) return notFound();
    const res = NextResponse.redirect(signed, 302);
    // The browser may reuse this redirect a little while, never past the
    // signed link's life, and never from a shared cache.
    res.headers.set('Cache-Control', 'private, max-age=240');
    res.headers.set('Referrer-Policy', 'no-referrer');
    return res;
  } catch (err) {
    return toErrorResponse(err);
  }
}
