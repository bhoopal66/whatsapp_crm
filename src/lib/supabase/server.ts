import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import {
  createServerRefresh,
  REFRESH_UNANSWERED_COOKIE,
} from '@/lib/supabase/session-fetch'
import {
  authCookieOptions,
  serverSupabaseUrl,
  sessionCookiesToWrite,
} from '@/lib/supabase/urls'

export async function createClient() {
  const cookieStore = await cookies()

  const refresh = createServerRefresh(() =>
    cookieStore.has(REFRESH_UNANSWERED_COOKIE)
  )
  const supabase = createServerClient(
    serverSupabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Must match the browser's cookie name — see urls.ts.
      cookieOptions: authCookieOptions(),
      global: { fetch: refresh.fetch },
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            sessionCookiesToWrite(cookiesToSet, cookieStore.getAll()).forEach(
              ({ name, value, options }) => cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    }
  )
  return refresh.bound(supabase)
}
