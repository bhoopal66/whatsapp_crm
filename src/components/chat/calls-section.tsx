'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { PhoneCall, PhoneMissed } from 'lucide-react';

import { useCalls } from '@/components/pbx/call-provider';
import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import {
  callsSidebar,
  openMissedTasks,
  startOfDay,
  type MyPhone,
} from '@/lib/pbx/timeline';
import { cn } from '@/lib/utils';

interface CallsState {
  me: MyPhone | null;
  hasPbx: boolean;
  missed: number;
  today: number;
}

const getJson = (url: string) =>
  fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

/**
 * The chat sidebar's CALLS rows (module 015): staff only, and only with
 * an extension of their own or a PBX in the workspace (callsSidebar).
 */
export function CallsSection({
  labelClassName,
  rowClassName,
}: {
  labelClassName: string;
  rowClassName: string;
}) {
  const t = useTranslations('ChatCalls');
  const { isBankGuest, user, activeWorkspaceId } = useAuth();
  const userId = user?.id ?? null;
  const softphoneStatus = useCalls()?.softphoneState.status ?? 'off';
  const [state, setState] = useState<CallsState | null>(null);

  useEffect(() => {
    if (isBankGuest) return;
    let cancelled = false;
    (async () => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const from = encodeURIComponent(startOfDay(Date.now(), tz));
      const [me, exts, tasks, calls] = await Promise.all([
        getJson('/api/pbx/me'),
        createClient()
          .from('pbx_extensions')
          .select('id', { count: 'exact', head: true }),
        getJson('/api/tasks?scope=mine&status=open&limit=200'),
        // Today's count is the person's own calls, as /calls opens on.
        getJson(`/api/pbx/calls?scope=mine&from=${from}&limit=200`),
      ]);
      if (cancelled) return;
      setState({
        me: me as MyPhone | null,
        hasPbx: (exts.count ?? 0) > 0,
        missed: openMissedTasks(tasks?.tasks ?? [], userId),
        today: Array.isArray(calls?.calls) ? calls.calls.length : 0,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [isBankGuest, userId, activeWorkspaceId]);

  const view = callsSidebar({
    isBankGuest,
    me: state?.me ?? null,
    workspaceHasPbx: state?.hasPbx ?? false,
    softphone: softphoneStatus,
  });
  if (!state || !view.visible) return null;

  return (
    <div>
      <p className={labelClassName}>{t('section')}</p>
      <ul>
        <li>
          <Link href="/calls" className={rowClassName}>
            <PhoneMissed className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t('missed')}</span>
            {state.missed > 0 && (
              <span
                className="min-w-5 rounded-full bg-amber-400 px-1.5 text-center text-[11px] font-bold text-amber-950"
                aria-label={t('missedCount', { count: state.missed })}
              >
                {state.missed}
              </span>
            )}
          </Link>
        </li>
        <li>
          <Link href="/calls" className={rowClassName}>
            <PhoneCall className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t('log')}</span>
            <span className="text-muted-foreground text-xs">
              {t('today', { count: state.today })}
            </span>
          </Link>
        </li>
      </ul>
      {view.line && (
        <p className="text-muted-foreground flex items-center gap-2 px-3 pt-1 text-xs">
          <span
            aria-hidden
            className={cn(
              'size-2 shrink-0 rounded-full',
              view.line.kind === 'softphone'
                ? 'bg-success'
                : view.line.kind === 'softphoneConnecting'
                  ? 'bg-warning animate-pulse'
                  : view.line.kind === 'softphoneError'
                    ? 'bg-destructive'
                    : 'border-muted-foreground border'
            )}
          />
          {t(view.line.kind, { ext: view.line.extension })}
        </p>
      )}
    </div>
  );
}
