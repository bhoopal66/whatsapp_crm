'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { useAuth } from '@/hooks/use-auth';
import { loadHrRoles } from '@/lib/hr/roles-cache';
import { legacyHrInboxTarget } from '@/lib/hr/routes';
import type { HrInbox, HrRoles } from '@/lib/hr/types';
import { createClient } from '@/lib/supabase/client';

/**
 * The old single HR inbox's URL. The HR screens have a route each now
 * (`/hr/recruiter`, `/hr/department`, `/hr/unsorted`), so a saved link
 * or a bookmark is sent on: with `?c=<id>` to that chat's own inbox
 * (its `hr_conversations.inbox`, read under RLS; no row is Not sorted),
 * else to the inbox the person's HR roles point at
 * (`legacyHrInboxTarget`). The target route's layout is the guard.
 */
export default function LegacyHrInboxPage() {
  return (
    <Suspense fallback={null}>
      <LegacyHrInboxRedirect />
    </Suspense>
  );
}

function LegacyHrInboxRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { accountId, user, profileLoading } = useAuth();
  const userId = user?.id ?? null;
  const search = searchParams.toString();

  useEffect(() => {
    if (profileLoading) return;
    let alive = true;
    const c = new URLSearchParams(search).get('c');
    const chatInbox = async (): Promise<HrInbox | null> => {
      if (!c) return null;
      const { data } = await createClient()
        .from('hr_conversations')
        .select('inbox')
        .eq('conversation_id', c)
        .maybeSingle();
      return (data?.inbox as HrInbox | undefined) ?? null;
    };
    const roles = async (): Promise<HrRoles | null> =>
      accountId && userId
        ? loadHrRoles(accountId, userId).catch(() => null)
        : null;
    Promise.all([chatInbox().catch(() => null), roles()]).then(([inbox, r]) => {
      if (alive) router.replace(legacyHrInboxTarget(search, inbox, r));
    });
    return () => {
      alive = false;
    };
  }, [profileLoading, accountId, userId, search, router]);

  return null;
}
