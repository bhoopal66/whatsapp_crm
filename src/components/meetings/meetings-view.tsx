'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Plus, Users, Video } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  formatMeetingWhen,
  MEETING_SCOPES,
  meetingDisplayStatus,
  parseMeetingList,
  type MeetingScope,
  type MeetingSummary,
} from '@/lib/meetings/schedule';
import { cn } from '@/lib/utils';

import { MeetingFormDialog } from './meeting-form-dialog';
import { MeetingStatusBadge } from './meeting-status-badge';
import {
  useMeetingTimeZone,
  useWorkspaceMembers,
} from './use-workspace-members';

/** How often Live now re-reads who is in each call. */
const LIVE_REFRESH_MS = 20_000;

interface Loaded {
  scope: MeetingScope;
  meetings: MeetingSummary[];
  failed: boolean;
}

/** /meetings — Live now (default), Upcoming (?scope=upcoming), Past. */
export function MeetingsView({ scope }: { scope: MeetingScope }) {
  const t = useTranslations('Meetings');
  const locale = useLocale();
  const timeZone = useMeetingTimeZone();
  const { nameOf } = useWorkspaceMembers();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(
    (signal?: { cancelled: boolean }) =>
      fetch(`/api/meetings?scope=${scope}`)
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((json) => {
          if (!signal?.cancelled)
            setLoaded({
              scope,
              meetings: parseMeetingList(json),
              failed: false,
            });
        })
        .catch(() => {
          if (!signal?.cancelled)
            setLoaded({ scope, meetings: [], failed: true });
        }),
    [scope]
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    const timer =
      scope === 'live'
        ? setInterval(() => void load(signal), LIVE_REFRESH_MS)
        : null;
    return () => {
      signal.cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [load, scope]);

  const current = loaded?.scope === scope ? loaded : null;
  const now = new Date();

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <Button
          onClick={() => {
            setDialogKey((k) => k + 1);
            setDialogOpen(true);
          }}
        >
          <Plus className="size-4" aria-hidden />
          {t('newMeeting')}
        </Button>
      </div>

      <nav className="flex flex-wrap gap-2" aria-label={t('title')}>
        {MEETING_SCOPES.map((k) => (
          <Link
            key={k}
            href={k === 'live' ? '/meetings' : `/meetings?scope=${k}`}
            aria-current={scope === k ? 'page' : undefined}
            className={cn(
              'rounded-full border px-3 py-1 text-sm',
              scope === k
                ? 'bg-foreground text-background border-transparent'
                : 'border-border text-muted-foreground hover:bg-muted'
            )}
          >
            {t(`tabs.${k}`)}
          </Link>
        ))}
      </nav>

      {!current ? (
        <div className="bg-muted h-24 animate-pulse rounded-xl" aria-hidden />
      ) : current.failed ? (
        <p className="text-destructive text-sm">{t('loadFailed')}</p>
      ) : current.meetings.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t(`empty.${scope}`)}</p>
      ) : (
        <section className="border-border bg-card overflow-hidden rounded-xl border">
          <ul>
            {current.meetings.map((m) => {
              const when =
                formatMeetingWhen(m, { locale, timeZone }) ?? t('instant');
              const host = nameOf(m.hostUserId) ?? t('unknownPerson');
              return (
                <li
                  key={m.id}
                  className="border-border flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
                >
                  <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-xl">
                    <Video className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/meetings/${m.id}`}
                      className="font-semibold hover:underline"
                    >
                      {m.title}
                    </Link>
                    <p className="text-muted-foreground truncate text-sm">
                      {[when, t('hostedBy', { name: host })].join(' · ')}
                    </p>
                  </div>
                  {m.presentCount > 0 && (
                    <span className="text-muted-foreground flex items-center gap-1 text-xs tabular-nums">
                      <Users className="size-3.5" aria-hidden />
                      {m.presentCount}
                    </span>
                  )}
                  <MeetingStatusBadge status={meetingDisplayStatus(m, now)} />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <MeetingFormDialog
        key={dialogKey}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        timeZone={timeZone}
        onSaved={() => void load()}
      />
    </div>
  );
}
