'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ExternalLink,
  Link2,
  Pencil,
  Trash2,
  UserRound,
  Video,
} from 'lucide-react';
import { toast } from 'sonner';

import { copyWithToast } from '@/components/context-menu/app-context-menu';
import type { ContextMenuEntry } from '@/components/context-menu/registry';

import { MeetingFormDialog } from '@/components/meetings/meeting-form-dialog';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useMeetingTimeZone } from '@/components/meetings/use-workspace-members';
import { calendarTimeZone } from '@/lib/calendar/fc-timezone';
import type { FeedItem } from '@/lib/calendar/feed';
import { popoverActions } from '@/lib/calendar/ui/popover-rules';
import {
  eventDragBody,
  isDragRefusal,
  meetingDragBody,
} from '@/lib/calendar/ui/drag';
import type { ViewKey } from '@/lib/calendar/ui/url-state';

import { calendarFetch, errorText, type EventDetail } from './calendar-api';
import { CalendarView } from './calendar-view';
import { EventDialog } from './event-dialog';
import { EventPopover, type PopoverTarget } from './event-popover';
import {
  ScopeDialog,
  type ScopeAnswer,
  type ScopePurpose,
  type ScopeQuestion,
} from './scope-dialog';

/**
 * The create/edit dialog's entry point. `range` is a drag-selected slot
 * (FullCalendar instants, end exclusive); `scope` is what the organiser
 * chose for a recurring event ('all' for a single one).
 */
export type EditorRequest =
  | {
      mode: 'create';
      range?: { start: Date; end: Date; allDay: boolean };
    }
  | { mode: 'edit'; item: FeedItem; scope: 'this' | 'all' };

/** /calendar: the view plus the popover, scope chooser and saving. */
export function CalendarPage({
  initialDate,
  initialView,
  initialEventId,
}: {
  initialDate?: string | null;
  initialView?: ViewKey;
  initialEventId?: string | null;
}) {
  const t = useTranslations('Calendar');
  const tMenu = useTranslations('ContextMenu');
  const td = useTranslations('Meetings.detail');
  const router = useRouter();
  const { user } = useAuth();
  const canCreateMeeting = useCan('create-meetings');
  const fcZone = calendarTimeZone(useMeetingTimeZone());
  const zone =
    fcZone === 'local'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : fcZone;

  const [refreshSignal, setRefreshSignal] = useState(0);
  const refresh = useCallback(() => setRefreshSignal((n) => n + 1), []);
  const [popover, setPopover] = useState<PopoverTarget | null>(null);
  const [question, setQuestion] = useState<
    (ScopeQuestion & { resolve: (a: ScopeAnswer) => void }) | null
  >(null);

  const ask = (purpose: ScopePurpose, recurring: boolean) =>
    new Promise<ScopeAnswer>((resolve) =>
      setQuestion({ purpose, recurring, resolve })
    );
  const answer = (a: ScopeAnswer) => {
    question?.resolve(a);
    setQuestion(null);
  };

  // One dialog at a time; `key` remounts it so it reads each request fresh.
  const [editor, setEditor] = useState<{
    request: EditorRequest;
    key: number;
  } | null>(null);
  const [meeting, setMeeting] = useState<{
    start: Date | undefined;
    key: number;
  } | null>(null);
  const openEditor = useCallback((request: EditorRequest) => {
    setEditor({ request, key: Date.now() });
  }, []);

  const recurring = (item: FeedItem) => item.kind === 'event' && item.recurring;

  const editItem = async (item: FeedItem) => {
    setPopover(null);
    const scope = recurring(item) ? await ask('edit', true) : 'all';
    if (scope) openEditor({ mode: 'edit', item, scope });
  };

  /** `expectedUpdatedAt`: the event's `updated_at` as the popover read it. */
  const deleteItem = async (item: FeedItem, expectedUpdatedAt: string) => {
    setPopover(null);
    const scope = await ask('delete', recurring(item));
    if (!scope) return;
    const q = new URLSearchParams({ scope, expectedUpdatedAt });
    if (scope === 'this') q.set('occurrenceStart', item.occurrenceStart);
    try {
      await calendarFetch(`/api/calendar/events/${item.id}?${q}`, {
        method: 'DELETE',
      });
      toast.success(t('popover.deleted'));
      refresh();
    } catch (err) {
      toast.error(t('popover.deleteFailed', { reason: errorText(err) }));
    }
  };

  // The popover's delete guard needs the event's `updated_at`, so the
  // menu reads the detail first and re-checks the popover's own rule.
  const deleteFromMenu = async (item: FeedItem) => {
    try {
      const detail = await calendarFetch<EventDetail>(
        `/api/calendar/events/${item.id}`
      );
      const allowed = popoverActions(
        item,
        {
          createdBy: detail.event.created_by,
          canEdit: detail.canEdit,
          attendees: detail.attendees,
        },
        user?.id ?? null
      ).remove;
      if (allowed) await deleteItem(item, detail.event.updated_at);
    } catch (err) {
      toast.error(t('popover.deleteFailed', { reason: errorText(err) }));
    }
  };

  // The popover's actions, gated as it gates them. An event's organiser
  // is known from the feed (the API's canEdit is the same created_by test).
  const eventMenuItems = (
    item: FeedItem,
    anchorEl: HTMLElement
  ): ContextMenuEntry[] => {
    const entries: ContextMenuEntry[] = [
      {
        id: 'open',
        label: tMenu('schedule.openDetails'),
        icon: ExternalLink,
        onSelect: () => setPopover({ item, anchorEl }),
      },
    ];
    if (item.kind === 'meeting') {
      const live = item.status !== 'ended' && item.status !== 'cancelled';
      if (live) {
        entries.push({
          id: 'join',
          label: t('popover.join'),
          icon: Video,
          onSelect: () => router.push(`/meetings/${item.id}/room`),
        });
      }
      entries.push(
        {
          id: 'openMeeting',
          label: t('popover.openMeeting'),
          icon: ExternalLink,
          onSelect: () => router.push(`/meetings/${item.id}`),
        },
        {
          id: 'copyLink',
          label: td('copyLink'),
          icon: Link2,
          onSelect: () =>
            void copyWithToast(
              `${window.location.origin}/meetings/${item.id}`,
              { copied: td('linkCopied'), failed: td('copyFailed') }
            ),
        }
      );
    } else if (item.kind === 'task') {
      const contactId = item.contactId;
      if (contactId) {
        entries.push({
          id: 'openContact',
          label: t('popover.openContact'),
          icon: UserRound,
          onSelect: () => router.push(`/contacts/${contactId}`),
        });
      }
    } else if (user && item.organizerId === user.id) {
      entries.push(
        { type: 'separator' },
        {
          id: 'edit',
          label: t('popover.edit'),
          icon: Pencil,
          onSelect: () => void editItem(item),
        },
        {
          id: 'delete',
          label: t('popover.delete'),
          icon: Trash2,
          destructive: true,
          onSelect: () => void deleteFromMenu(item),
        }
      );
    }
    return entries;
  };

  const onEventChange = async (
    item: FeedItem,
    newStart: Date,
    newEnd: Date | null,
    revert: () => void
  ) => {
    if (item.kind === 'task') return revert();
    try {
      if (item.kind === 'meeting') {
        await calendarFetch(`/api/meetings/${item.id}`, {
          method: 'PATCH',
          body: meetingDragBody(item, newStart, newEnd),
        });
      } else {
        const { event } = await calendarFetch<EventDetail>(
          `/api/calendar/events/${item.id}`
        );
        const scope = item.recurring ? await ask('move', true) : 'all';
        if (!scope) return revert();
        const body = eventDragBody(item, event, newStart, newEnd, scope, zone);
        if (isDragRefusal(body)) {
          revert();
          toast.error(
            t('popover.moveFailed', {
              reason: t('popover.seriesRuleConflict'),
            })
          );
          return;
        }
        await calendarFetch(`/api/calendar/events/${item.id}`, {
          method: 'PATCH',
          body: { ...body, expectedUpdatedAt: event.updated_at },
        });
      }
      toast.success(t('popover.moved'));
      refresh();
    } catch (err) {
      revert();
      toast.error(t('popover.moveFailed', { reason: errorText(err) }));
    }
  };

  return (
    <>
      <CalendarView
        initialDate={initialDate}
        initialView={initialView}
        initialEventId={initialEventId}
        refreshSignal={refreshSignal}
        onEventClick={(item, anchorEl) => setPopover({ item, anchorEl })}
        onSelectRange={(start, end, allDay) =>
          openEditor({ mode: 'create', range: { start, end, allDay } })
        }
        onCreate={() => openEditor({ mode: 'create' })}
        onEventChange={onEventChange}
        getEventMenuItems={eventMenuItems}
      />
      <EventPopover
        target={popover}
        zone={zone}
        onClose={() => setPopover(null)}
        onEdit={editItem}
        onDelete={deleteItem}
        onChanged={refresh}
      />
      <ScopeDialog question={question} onAnswer={answer} />
      {editor && (
        <EventDialog
          key={editor.key}
          request={editor.request}
          zone={zone}
          onClose={() => setEditor(null)}
          onSaved={refresh}
          onVideoMeeting={
            canCreateMeeting
              ? (start) => {
                  setEditor(null);
                  setMeeting({ start, key: Date.now() });
                }
              : undefined
          }
        />
      )}
      {meeting && (
        <MeetingFormDialog
          key={meeting.key}
          open
          onOpenChange={(open) => {
            if (!open) setMeeting(null);
          }}
          timeZone={zone}
          initialStart={meeting.start}
          onSaved={refresh}
        />
      )}
    </>
  );
}
