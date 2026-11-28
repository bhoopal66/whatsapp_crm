import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import {
  createServerRefresh,
  REFRESH_UNANSWERED_COOKIE,
} from '@/lib/supabase/session-fetch'
import {
  AUTH_COOKIE_NAME,
  authCookieOptions,
  serverSupabaseUrl,
  sessionCookiesToWrite,
} from '@/lib/supabase/urls'
import {
  authUnavailableResponse,
  isAuthUnavailable,
} from '@/lib/auth/auth-unavailable'
import { safeNextPath } from '@/lib/auth/login-client'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { contentSecurityPolicy } from '@/lib/csp'
import { isCrossSiteApiWrite } from '@/lib/edge/same-origin'
import { createFrameOriginsLookup } from '@/lib/web-form/frame-lookup'
import {
  frameHeadersFor,
  webFormFramePathToken,
} from '@/lib/web-form/frame-headers'
import { loadPublicForm } from '@/lib/web-form/server'
import { isWellFormedToken } from '@/lib/web-form/submission'

// The hosted web form (/f/<token>) is the one page another site may
// frame, and only a site on that form's own allow-list. next.config.ts
// leaves /f/* out of the global X-Frame-Options / Report-Only CSP, and
// the frame headers are set here per request (frame-headers.ts explains
// the exact headers). Here rather than in the page: a server component
// cannot set response headers. The lookup is the service-role
// `web_form_public_config`, cached 30 s per process, and fails closed
// to frame-ancestors 'none' + X-Frame-Options DENY.
const webFormFrameOrigins = createFrameOriginsLookup({
  load: (token) => loadPublicForm(supabaseAdmin(), token),
})
const REPORT_ONLY_CSP = contentSecurityPolicy({
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  linkusSdkUrl: process.env.NEXT_PUBLIC_LINKUS_SDK_URL,
  pbxOrigin: process.env.NEXT_PUBLIC_PBX_ORIGIN,
})

async function webFormFrameHeaders(pathname: string) {
  // Exactly /f/<64 hex> or the route it posts to; anything else under
  // those prefixes is never framable.
  const token = webFormFramePathToken(pathname) ?? ''
  const origins = isWellFormedToken(token)
    ? await webFormFrameOrigins(token)
    : []
  return frameHeadersFor(origins, { reportOnlyCsp: REPORT_ONLY_CSP })
}

export async function middleware(request: NextRequest) {
  // A state-changing /api call a browser made from another site or
  // subdomain (CSRF): refused before any session work. Webhooks, crons
  // and API-key callers send no browser headers and are not affected.
  if (
    isCrossSiteApiWrite({
      method: request.method,
      pathname: request.nextUrl.pathname,
      headers: request.headers,
    })
  ) {
    return NextResponse.json(
      { error: 'Cross-site request refused' },
      { status: 403 }
    )
  }

  let supabaseResponse = NextResponse.next({ request })

  const refresh = createServerRefresh()
  const supabase = createServerClient(
    serverSupabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Must match the browser's cookie name — see urls.ts. Without
      // this the middleware cannot see the session and redirects every
      // signed-in request straight back to /login.
      cookieOptions: authCookieOptions(),
      global: { fetch: refresh.fetch },
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          const writes = sessionCookiesToWrite(
            cookiesToSet,
            request.cookies.getAll()
          )
          writes.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          writes.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user }, error: authError } =
    await refresh.bound(supabase).auth.getUser()

  // This request has waited once: what it reaches does not ask again.
  if (refresh.gaveUp()) {
    request.cookies.set(REFRESH_UNANSWERED_COOKIE, '1')
    // What getUser() wrote stays: a token still valid may have been used
    // to learn that the session has ended.
    const written = supabaseResponse.cookies.getAll()
    supabaseResponse = NextResponse.next({ request })
    written.forEach((cookie) => supabaseResponse.cookies.set(cookie))
  }

  // The auth service did not answer, for someone who holds a session
  // cookie: that is not a sign-out, so neither the redirect to /login nor
  // the 401 below applies. The page goes through (server guards and RLS
  // still decide; no user is loaded here either way). auth-js keeps the
  // cookie on a retryable failure, so the next request simply works.
  const sessionUnknown =
    !user &&
    isAuthUnavailable(authError) &&
    request.cookies.getAll().some(
      ({ name, value }) =>
        // The whole cookie, or the first of its chunks (".0", ".1", …).
        value !== '' &&
        (name === AUTH_COOKIE_NAME || name === `${AUTH_COOKIE_NAME}.0`)
    )

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  // `/signup` is not listed because it no longer exists — this CRM
  // has no self-service signup; admins provision logins from
  // Settings -> Members.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (inviteToken && request.nextUrl.pathname === '/login') {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      // A same-origin `next` (a deep link that bounced through /login)
      // wins; otherwise `/`, whose page reads the role once and picks
      // the landing page (My worklist for agents and team leaders,
      // `landingPathForRole`). No role read here: this runs on every
      // request.
      const next = safeNextPath(request.nextUrl.searchParams.get('next'))
      const target = new URL(next ?? '/', request.nextUrl.origin)
      url.pathname = target.pathname
      url.search = target.search
      url.hash = target.hash
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login if not authenticated. This is
  // every route group under src/app/(dashboard) — keep it in step when
  // a screen is added, or the new screen ships its whole client bundle
  // to a logged-out visitor before the shell's client-side redirect
  // fires (/flows, /agents, /notifications and the /team-* pairs were
  // missing here for months).
  const protectedPaths = [
    '/dashboard',
    '/worklist',
    '/inbox',
    '/team-inbox',
    '/hr-inbox',
    // The HR screens (/hr, /hr/recruiter, /hr/tasks, …). As a prefix it
    // also covers /hr-inbox; no public route starts with /hr.
    '/hr',
    '/contacts',
    '/team-contacts',
    '/team-activity',
    '/my-activity',
    '/live',
    '/pipelines',
    '/broadcasts',
    '/automations',
    '/flows',
    '/agents',
    '/compass',
    '/opendesk',
    '/notifications',
    '/settings',
    '/chat',
    '/tasks',
    '/journeys',
    '/calls',
    '/meetings',
    '/calendar',
    '/groups',
    '/group-wall',
    '/submission-groups',
    '/cases',
    '/desk',
    '/recycle',
    '/banks',
    '/brain',
    '/digest',
    // Reports (migrations 254-255): /reports, /reports/tags, /reports/funnel.
    '/reports',
  ]
  if (!user && !sessionUnknown && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    // Remember the deep link: after signing in, the login page sends
    // them back to it instead of their landing page (`loginDestination`).
    url.search = ''
    url.searchParams.set(
      'next',
      request.nextUrl.pathname + request.nextUrl.search
    )
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // API routes that need auth. Some authenticate themselves rather
  // than through a session: the inbound webhooks (gateway secret /
  // HMAC), and the broadcast scheduler's and channel health monitor's
  // cron endpoints (`x-cron-secret`, like /api/automations/cron and
  // /api/flows/cron, which sit outside this prefix and never hit this
  // gate).
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook') &&
      request.nextUrl.pathname !== '/api/whatsapp/broadcast/cron' &&
      request.nextUrl.pathname !== '/api/whatsapp/health/cron') {
    return withRefreshedCookies(
      sessionUnknown
        ? authUnavailableResponse()
        : NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  // /f/* got no frame headers from next.config.ts: every /f/ response
  // that reaches this point gets them here. (No branch above returns
  // early for /f/: it is neither an auth page, a protected screen nor
  // an API route.) Set on `supabaseResponse` itself, so the refreshed
  // cookies ride along unchanged.
  // The form's post route (/api/public/web-form/<token>) too: its 303
  // back to the page is shown inside the iframe, and Chrome applies the
  // frame headers to it there (next.config.ts leaves it out as well).
  if (
    request.nextUrl.pathname.startsWith('/f/') ||
    request.nextUrl.pathname.startsWith('/api/public/web-form/')
  ) {
    const headers = await webFormFrameHeaders(request.nextUrl.pathname)
    for (const [key, value] of Object.entries(headers)) {
      supabaseResponse.headers.set(key, value)
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    // sw.js and the web app manifest are fetched by the browser itself
    // (service-worker update checks, install prompts): no session work.
    // Nor for the reports a browser sends about the CSP.
    '/((?!_next/static|_next/image|favicon.ico|sw\\.js$|manifest\\.webmanifest$|api/csp-report$|meeting-effects/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
