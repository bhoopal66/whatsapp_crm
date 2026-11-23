import { redirect } from 'next/navigation';

import { pickActiveProfile } from '@/lib/auth/active-profile';
import { isAuthUnavailable } from '@/lib/auth/auth-unavailable';
import { landingPathForRole } from '@/lib/auth/landing';
import { isAccountRole } from '@/lib/auth/roles';
import { createClient } from '@/lib/supabase/server';

/**
 * `/` — the landing redirect. Sign-in without a `next` path, and the
 * middleware's bounce of a signed-in visitor off /login, come here, so
 * the role → landing read (one profiles query) happens on this redirect
 * only, never on every request. Agents and team leaders land on My
 * worklist, everyone else as before (`landingPathForRole`). Any failure
 * falls back to the dashboard.
 */
export default async function RootPage() {
  redirect(await landingPath());
}

async function landingPath(): Promise<string> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    // No answer is not "signed out" (auth-unavailable.ts).
    if (isAuthUnavailable(authError)) return '/dashboard';
    if (!user) return '/login';
    // `*`, not a column list, like getCurrentAccount: a missing column
    // (an unapplied migration) must not fail the read. RLS hands a
    // person every own row; the active one is the workspace (083).
    const { data: rows, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', user.id);
    if (error) return '/dashboard';
    const row = pickActiveProfile(
      rows as
        { account_role: string | null; is_active?: boolean | null }[] | null
    );
    const role = row?.account_role;
    return landingPathForRole(isAccountRole(role) ? role : null);
  } catch {
    return '/dashboard';
  }
}
