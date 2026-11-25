import {
  createBrowserClient,
  parseCookieHeader,
  serializeCookieHeader,
  type CookieMethodsBrowser,
} from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

import { createSessionFetch } from './session-fetch'
import { authCookieOptions, publicSupabaseUrl, sessionCookieWrite } from './urls'

// Singleton instance — one client shared across the whole browser session.
// Creating multiple clients causes auth-lock contention ("Lock was released
// because another request stole it") and intermittent fetch failures.
let browserClient: SupabaseClient | undefined

/** @supabase/ssr's own document.cookie methods, except that a session
 *  cookie is written with our idle limit (see `sessionCookieWrite`). Most
 *  token refreshes happen here, so this is the write that counts. */
export const browserCookies: CookieMethodsBrowser = {
  getAll: () =>
    parseCookieHeader(document.cookie).map(({ name, value }) => ({
      name,
      value: value ?? '',
    })),
  setAll: (cookiesToSet) => {
    cookiesToSet.forEach(({ name, value, options }) => {
      document.cookie = serializeCookieHeader(
        name,
        value,
        sessionCookieWrite(options)
      )
    })
  },
}

export function createClient() {
  if (browserClient) return browserClient

  // Explicitly the PUBLIC url — see lib/supabase/urls.ts. On a
  // self-hosted install the server talks to Supabase over a private
  // address the browser cannot reach.
  browserClient = createBrowserClient(
    publicSupabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    // Pin the session cookie name — the default is derived from the
    // URL, which differs between browser and server here. See urls.ts.
    {
      cookieOptions: authCookieOptions(),
      // Not while pre-rendering: there is no document, and no cookie.
      ...(typeof document === 'undefined' ? {} : { cookies: browserCookies }),
      global: { fetch: createSessionFetch() },
    }
  )

  return browserClient
}
