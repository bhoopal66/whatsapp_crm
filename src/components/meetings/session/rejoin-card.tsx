'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { parseMeetingDetail } from '@/lib/meetings/schedule';
import { meetingRoomIdFrom } from '@/lib/meetings/session/paths';
import {
  readRejoinMarker,
  REJOIN_MARKER_KEY,
  type RejoinMarker,
} from '@/lib/meetings/session/session';

function readStoredMarker(userId: string | null): RejoinMarker | null {
  try {
    const raw = sessionStorage.getItem(REJOIN_MARKER_KEY);
    return readRejoinMarker(raw, userId, Date.now());
  } catch {
    return null;
  }
}

function clearMarker() {
  try {
    sessionStorage.removeItem(REJOIN_MARKER_KEY);
  } catch {
    // No storage: there was no marker either.
  }
}

async function stillOn(meetingId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}`);
    if (!res.ok) return false;
    const detail = parseMeetingDetail(await res.json());
    return detail?.meeting.status === 'scheduled';
  } catch {
    return false;
  }
}

/** A reload ended the call: offer the way back, if the meeting is on. */
export function RejoinCard() {
  const t = useTranslations('MeetingSession.rejoin');
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [marker, setMarker] = useState<RejoinMarker | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = readStoredMarker(userId);
      if (!found) return;
      const on = await stillOn(found.meetingId);
      if (cancelled) return;
      if (on) setMarker(found);
      else clearMarker();
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!marker || meetingRoomIdFrom(pathname) === marker.meetingId) return null;
  const dismiss = () => {
    clearMarker();
    setMarker(null);
  };
  return (
    <div
      role="status"
      className="bg-card text-card-foreground fixed right-4 bottom-4 z-40 flex w-72 flex-col gap-2 rounded-lg border p-3 shadow-lg"
    >
      <p className="text-sm font-medium break-words">
        {t('title', { title: marker.title })}
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          className="flex-1"
          onClick={() => router.push(`/meetings/${marker.meetingId}/room`)}
        >
          {t('rejoin')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={dismiss}>
          {t('dismiss')}
        </Button>
      </div>
    </div>
  );
}
