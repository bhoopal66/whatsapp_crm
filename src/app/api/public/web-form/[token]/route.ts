// ============================================================
// POST /api/public/web-form/[token] — the public web form (migration
// 249, docs/web-form.md). No session: the token in the path is the
// form's address.
//
// Body: JSON or application/x-www-form-urlencoded (a plain HTML <form>
// works with no script), at most 8 KB. Fields: name, phone (required),
// email, message, page_url; `website` is a hidden honeypot.
//
// Answers. JSON: 200 { ok: true }, 404 { error: 'not_found' } (an
// unknown and a switched-off form alike), 403 'origin_not_allowed', 413,
// 415, 422 { error, field }, 429 'rate_limited', 500. A urlencoded post
// (a browser form) gets a 303 to the hosted page instead: /f/<token>
// ?sent=1 on success, ?error=<code> on a 422; the other refusals stay
// plain statuses.
//
// Order: token shape, rate limits (per client IP, per client IP on
// this form; fail closed), body type and size, the form lookup, the
// Origin rule (src/lib/web-form/origin.ts), the honeypot (a bot gets the
// success answer and nothing is stored), validation, the form's own rate
// limit (fail closed too), then web_form_submit. It never sends a
// WhatsApp message.
//
// OPTIONS (the CORS preflight) spends the per-IP bucket before its form
// lookup, so preflights cannot be used to hammer the database.
// ============================================================

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { RateLimiter, RpcRateStore } from '@/lib/edge';
import { clientIp } from '@/lib/edge/client-ip';
import { decideOrigin, originOfUrl } from '@/lib/web-form/origin';
import { loadPublicForm, submitWebForm } from '@/lib/web-form/server';
import {
  MAX_BODY_BYTES,
  bodyKindOf,
  isHoneypotFilled,
  isWellFormedToken,
  readFields,
  validateSubmission,
  type BodyKind,
} from '@/lib/web-form/submission';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ token: string }> };

function selfOrigins(request: Request): string[] {
  const out = [
    originOfUrl(process.env.NEXT_PUBLIC_SITE_URL),
    originOfUrl(request.url),
  ];
  // Behind a tunnel request.url is the internal address; the Host the
  // browser used is what its Origin carries. A browser cannot forge
  // Host on a cross-site request, so this widens nothing.
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (host) out.push(originOfUrl(`https://${host.split(',')[0].trim()}`));
  return out.filter((o): o is string => Boolean(o));
}

function withCors(res: NextResponse, cors: string | null): NextResponse {
  if (cors) {
    res.headers.set('Access-Control-Allow-Origin', cors);
    res.headers.append('Vary', 'Origin');
  }
  return res;
}

function json(status: number, body: unknown, cors: string | null = null) {
  return withCors(NextResponse.json(body, { status }), cors);
}

function backToPage(
  token: string,
  query: string,
  cors: string | null
): NextResponse {
  // Relative, so the browser resolves it against the address it posted
  // to (the public one, whatever the internal request.url says).
  const res = new NextResponse(null, {
    status: 303,
    headers: { Location: `/f/${token}?${query}` },
  });
  return withCors(res, cors);
}

/** The body as text, refusing more than `max` bytes without reading it all. */
async function readCapped(
  request: Request,
  max: number
): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function limiter(): RateLimiter {
  return new RateLimiter(new RpcRateStore(supabaseAdmin()));
}

/**
 * The client, or with no known address the form itself: one bucket for
 * every visitor of every form would let one caller shut them all.
 */
function ipOf(request: Request, token: string): string {
  return clientIp(request.headers) ?? `form:${token}`;
}

function tooMany(retryAfterMs: number): NextResponse {
  const res = json(429, { error: 'rate_limited' });
  res.headers.set(
    'Retry-After',
    String(Math.max(1, Math.ceil(retryAfterMs / 1000)))
  );
  return res;
}

/** The preflight's limit: per client IP only, before any lookup. */
async function preflightRateLimited(
  request: Request,
  token: string
): Promise<number | null> {
  const byIp = await limiter().check('webform.ip', ipOf(request, token));
  return byIp.allowed ? null : byIp.retryAfterMs;
}

async function rateLimited(
  request: Request,
  token: string
): Promise<number | null> {
  const rl = limiter();
  const ip = ipOf(request, token);
  const byIp = await rl.check('webform.ip', ip);
  if (!byIp.allowed) return byIp.retryAfterMs;
  // Keyed like 'webform.token' (the token itself), plus the address.
  // Skipped with no known client IP: every visitor would share one
  // bucket of 5 an hour, far below the form's own allowance.
  if (clientIp(request.headers)) {
    const byIpForm = await rl.check('webform.ip_token', `${token}|${ip}`);
    if (!byIpForm.allowed) return byIpForm.retryAfterMs;
  }
  return null;
}

/**
 * The form's own hourly allowance, spent only by a submission that is
 * about to be stored: junk (a refused Origin, the honeypot, a bad field)
 * must not use up the allowance of genuine leads.
 */
async function formRateLimited(token: string): Promise<number | null> {
  const byForm = await limiter().check('webform.token', token);
  return byForm.allowed ? null : byForm.retryAfterMs;
}

export async function OPTIONS(request: Request, { params }: Params) {
  const { token } = await params;
  if (!isWellFormedToken(token)) return json(404, { error: 'not_found' });
  try {
    const retryAfterMs = await preflightRateLimited(request, token);
    if (retryAfterMs !== null) return tooMany(retryAfterMs);
    const form = await loadPublicForm(supabaseAdmin(), token);
    if (!form) return json(404, { error: 'not_found' });
    const decision = decideOrigin({
      origin: request.headers.get('origin'),
      selfOrigins: selfOrigins(request),
      allowed: form.allowedOrigins,
    });
    if (!decision.ok) return json(403, { error: 'origin_not_allowed' });
    const res = new NextResponse(null, { status: 204 });
    if (decision.cors) {
      res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
      res.headers.set('Access-Control-Max-Age', '600');
    }
    return withCors(res, decision.cors);
  } catch (err) {
    console.error('[web-form] preflight failed:', String(err));
    return json(500, { error: 'internal_error' });
  }
}

export async function POST(request: Request, { params }: Params) {
  const { token } = await params;
  if (!isWellFormedToken(token)) return json(404, { error: 'not_found' });

  try {
    const retryAfterMs = await rateLimited(request, token);
    if (retryAfterMs !== null) return tooMany(retryAfterMs);

    const kind: BodyKind | null = bodyKindOf(
      request.headers.get('content-type')
    );
    if (!kind) return json(415, { error: 'unsupported_media_type' });
    const text = await readCapped(request, MAX_BODY_BYTES);
    if (text === null) return json(413, { error: 'too_large' });

    const form = await loadPublicForm(supabaseAdmin(), token);
    if (!form) return json(404, { error: 'not_found' });

    const decision = decideOrigin({
      origin: request.headers.get('origin'),
      selfOrigins: selfOrigins(request),
      allowed: form.allowedOrigins,
    });
    if (!decision.ok) return json(403, { error: 'origin_not_allowed' });
    const cors = decision.cors;

    const fields = readFields(kind, text);
    if (!fields) return json(400, { error: 'bad_body' }, cors);

    const success = () =>
      kind === 'form'
        ? backToPage(token, 'sent=1', cors)
        : json(200, { ok: true }, cors);

    // A bot filled the hidden field: answer as if it worked, keep nothing.
    if (isHoneypotFilled(fields)) return success();

    const checked = validateSubmission(fields, request.headers.get('referer'));
    if (!checked.ok) {
      return kind === 'form'
        ? backToPage(token, `error=${checked.error}`, cors)
        : json(422, { error: checked.error, field: checked.field }, cors);
    }

    const formRetryMs = await formRateLimited(token);
    if (formRetryMs !== null) return tooMany(formRetryMs);

    const outcome = await submitWebForm(supabaseAdmin(), token, checked.value);
    if (outcome.status === 'not_found')
      return json(404, { error: 'not_found' });
    if (outcome.status === 'bad_phone') {
      return kind === 'form'
        ? backToPage(token, 'error=bad_phone', cors)
        : json(422, { error: 'bad_phone', field: 'phone' }, cors);
    }
    return success();
  } catch (err) {
    // Never the payload: it is a stranger's personal data.
    console.error('[web-form] submission failed:', String(err));
    return json(500, { error: 'internal_error' });
  }
}
