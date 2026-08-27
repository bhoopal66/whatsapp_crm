import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { AUTH_COOKIE_NAME, serverSupabaseUrl } from '@/lib/supabase/urls'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    serverSupabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Must match the browser's cookie name — see urls.ts.
      cookieOptions: { name: AUTH_COOKIE_NAME },
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    }
  )
}
