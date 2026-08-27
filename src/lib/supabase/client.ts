import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

import { AUTH_COOKIE_NAME, publicSupabaseUrl } from './urls'

// Singleton instance — one client shared across the whole browser session.
// Creating multiple clients causes auth-lock contention ("Lock was released
// because another request stole it") and intermittent fetch failures.
let browserClient: SupabaseClient | undefined

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
    { cookieOptions: { name: AUTH_COOKIE_NAME } }
  )

  return browserClient
}
