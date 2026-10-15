'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { presentOthers } from '@/lib/meetings/room-ui/lobby';
import { avatarColor, initials } from '@/lib/meetings/room-ui/people';
import { cn } from '@/lib/utils';

import { useWorkspaceMembers } from '../use-workspace-members';

/** People join while we wait in the lobby, so the list is re-read. */
const POLL_MS = 15_000;
const MAX_FACES = 5;
const MAX_NAMES = 3;

/**
 * The meeting's present seats, read from `GET /api/meetings/[id]`: the
 * engine has no participants until we join. A failed read keeps the
 * last answer.
 */
function usePresentSeats(meetingId: string): unknown {
  const [body, setBody] = useState<unknown>(undefined);
  useEffect(() => {
    let ctrl: AbortController | null = null;
    const load = async () => {
      if (document.hidden) return;
      ctrl?.abort();
      const mine = new AbortController();
      ctrl = mine;
      try {
        const res = await fetch(`/api/meetings/${meetingId}`, {
          cache: 'no-store',
          signal: mine.signal,
        });
        if (!res.ok) return;
        const json: unknown = await res.json();
        if (!mine.signal.aborted) setBody(json);
      } catch {
        // Offline or aborted: keep what we showed.
      }
    };
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => {
      clearInterval(id);
      ctrl?.abort();
    };
  }, [meetingId]);
  return body;
}

/** "Who's already in the call", with faces and a count. */
export function LobbyPeople({ meetingId }: { meetingId: string }) {
  const t = useTranslations('MeetingRoom.lobbyV2');
  const { user } = useAuth();
  const { nameOf } = useWorkspaceMembers();
  const body = usePresentSeats(meetingId);
  const { people, count } = useMemo(
    () => presentOthers(body, user?.id ?? null, nameOf),
    [body, user?.id, nameOf]
  );
  // Not read yet, or an answer we cannot read: say nothing rather than
  // claim the room is empty.
  if (count === null) return null;

  const named = people.filter((p) => p.name).map((p) => p.name as string);
  const shown = named.slice(0, MAX_NAMES);
  const rest = count - shown.length;
  const faces = people.slice(0, MAX_FACES);
  const extraFaces = people.length - faces.length;

  return (
    <section className="space-y-2" aria-live="polite">
      <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {t('whoIsHere')}
      </h2>
      {count === 0 ? (
        <p className="text-muted-foreground text-sm">{t('nobodyYet')}</p>
      ) : (
        <div className="flex items-center gap-3">
          {faces.length > 0 && (
            <ul className="flex -space-x-2">
              {faces.map((p) => {
                const name = p.name ?? t('someone');
                return (
                  <li
                    key={p.userId}
                    title={name}
                    className={cn(
                      'ring-background flex size-9 items-center justify-center rounded-full text-xs font-medium text-white ring-2',
                      avatarColor(p.userId)
                    )}
                  >
                    <span aria-hidden>{initials(p.name ?? '') || '?'}</span>
                    <span className="sr-only">{name}</span>
                  </li>
                );
              })}
              {extraFaces > 0 && (
                <li
                  className="bg-muted text-muted-foreground ring-background flex size-9 items-center justify-center rounded-full text-xs font-medium ring-2"
                  aria-hidden
                >
                  +{extraFaces}
                </li>
              )}
            </ul>
          )}
          <div className="min-w-0 text-sm">
            <p className="font-medium">{t('peopleInCall', { count })}</p>
            {shown.length > 0 && (
              <p className="text-muted-foreground truncate">
                {shown.join(', ')}
                {rest > 0 && ` ${t('morePeople', { count: rest })}`}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
