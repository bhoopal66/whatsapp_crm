'use client';

import { useEffect, useState } from 'react';

import { useCalls } from '@/components/pbx/call-provider';
import { useAuth } from '@/hooks/use-auth';
import { callsSidebar, openMissedTasks } from '@/lib/pbx/timeline';
import { createClient } from '@/lib/supabase/client';

interface Loaded {
  workspace: string | null;
  hasPbx: boolean;
  missed: number;
}

/**
 * The sidebar's Calls row (module 015), by the chat sidebar's CALLS rule
 * (`callsSidebar`: staff, with an extension of their own or one in the
 * workspace), with the same pill: open missed-call tasks assigned to
 * this person. Asked once per workspace, never for a bank guest, and
 * hidden until answered or on any error.
 */
export function useCallsNav(): { visible: boolean; missed: number } {
  const { isBankGuest, user, activeWorkspaceId, profileLoading } = useAuth();
  const me = useCalls()?.me ?? null;
  const userId = user?.id ?? null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (profileLoading || isBankGuest || !userId) return;
    let cancelled = false;
    (async () => {
      const exts = await createClient()
        .from('pbx_extensions')
        .select('id', { count: 'exact', head: true });
      const hasPbx = !exts.error && (exts.count ?? 0) > 0;
      const tasks = hasPbx
        ? await fetch('/api/tasks?scope=mine&status=open&limit=200')
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
        : null;
      if (!cancelled)
        setLoaded({
          workspace: activeWorkspaceId,
          hasPbx,
          missed: openMissedTasks(tasks?.tasks ?? [], userId),
        });
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profileLoading, isBankGuest, userId, activeWorkspaceId]);

  const current = loaded?.workspace === activeWorkspaceId ? loaded : null;
  const visible =
    !!current &&
    callsSidebar({
      isBankGuest,
      me,
      workspaceHasPbx: current.hasPbx,
      softphone: 'off',
    }).visible;
  return { visible, missed: visible && current ? current.missed : 0 };
}
