'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import {
  Bell,
  Check,
  Clock,
  HelpCircle,
  MapPin,
  Pencil,
  Repeat,
  Trash2,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { useAuth } from '@/hooks/use-auth';
import { useMediaQuery } from '@/hooks/use-media-query';
import type { AttendeeResponse, FeedItem } from '@/lib/calendar/feed';
import { describeRrule } from '@/lib/calendar/rrule-form';
import { colorVar } from '@/lib/calendar/ui/colors';
import { dateKeyInZone } from '@/lib/calendar/ui/event-form';
import { repeatValues, whenText } from '@/lib/calendar/ui/popover-format';
import {
  descriptionParts,
  popoverActions,
} from '@/lib/calendar/ui/popover-rules';
import {
  REMINDER_PRESETS,
  reminderLabel,
  toggleReminder,
} from '@/lib/calendar/ui/reminder-chips';
import { cn } from '@/lib/utils';

import { calendarFetch, errorText, type EventDetail } from './calendar-api';

export interface PopoverTarget {
  item: FeedItem;
  anchorEl: HTMLElement;
}

interface EventPopoverProps {
  target: PopoverTarget | null;
  /** The zone the calendar is drawn in (never 'local'). */
  zone: string;
  onClose: () => void;
  /** Organiser's Edit: the page asks for a scope, then opens the editor. */
  onEdit: (item: FeedItem) => void;
  /** With the event's `updated_at` as loaded (the delete's guard). */
  onDelete: (item: FeedItem, expectedUpdatedAt: string) => void;
  /** After a successful write, so the calendar refetches. */
  onChanged: () => void;
}

const POPUP_CLASS =
  'z-50 flex max-h-(--available-height) w-80 origin-(--transform-origin) flex-col overflow-y-auto rounded-lg bg-popover p-3 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95';

/**
 * The event popover: anchored to the clicked event, a bottom sheet on a
 * phone-width screen. Events load their detail on open; meetings and
 * tasks show what the feed already has.
 */
export function EventPopover({ target, ...rest }: EventPopoverProps) {
  const narrow = useMediaQuery('(max-width: 640px)');
  const open = target !== null;
  const onOpenChange = (next: boolean) => {
    if (!next) rest.onClose();
  };
  const body = target && (
    <PopoverBody
      key={`${target.item.kind}:${target.item.id}:${target.item.occurrenceStart}`}
      item={target.item}
      {...rest}
    />
  );

  if (narrow) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="max-h-[85vh] overflow-y-auto p-4"
        >
          {body}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={target?.anchorEl}
          side="right"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="isolate z-50"
        >
          <PopoverPrimitive.Popup
            data-slot="popover-content"
            className={POPUP_CLASS}
          >
            {body}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

const RESPONSE_ICON: Record<AttendeeResponse, LucideIcon> = {
  accepted: Check,
  tentative: HelpCircle,
  declined: X,
  pending: Clock,
};

const RESPONSE_TONE: Record<AttendeeResponse, string> = {
  accepted: 'text-success',
  tentative: 'text-warning',
  declined: 'text-destructive',
  pending: 'text-muted-foreground',
};

function Row({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

function PopoverBody({
  item,
  zone,
  onClose,
  onEdit,
  onDelete,
  onChanged,
}: Omit<EventPopoverProps, 'target'> & { item: FeedItem }) {
  const t = useTranslations('Calendar');
  const locale = useLocale();
  const { user } = useAuth();
  const { nameOf } = useWorkspaceMembers();
  const isEvent = item.kind === 'event';

  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // null: the event's own reminders until "Notify me" is changed here.
  const [reminders, setReminders] = useState<number[] | null>(null);

  useEffect(() => {
    if (!isEvent) return;
    const ctl = new AbortController();
    calendarFetch<EventDetail>(`/api/calendar/events/${item.id}`, {
      signal: ctl.signal,
    })
      .then(setDetail)
      .catch((err) => {
        if (!ctl.signal.aborted) setLoadError(errorText(err));
      });
    return () => ctl.abort();
  }, [isEvent, item.id]);

  const actions = popoverActions(
    item,
    detail
      ? {
          createdBy: detail.event.created_by,
          canEdit: detail.canEdit,
          attendees: detail.attendees,
        }
      : null,
    user?.id ?? null
  );
  const loading = isEvent && !detail && !loadError;
  const ev = detail?.event;
  const personName = (id: string) => nameOf(id) ?? t('popover.unknownPerson');

  const repeat = (() => {
    if (!ev?.rrule) return null;
    const desc = describeRrule(ev.rrule, {
      date: dateKeyInZone(Date.parse(ev.start_at), ev.time_zone),
      timeZone: ev.time_zone,
    });
    if (!desc) return null;
    const values = repeatValues(desc, locale);
    const rule = t(`repeat.${desc.key}`, values);
    if (values.until !== undefined) {
      return t('repeat.endsOn', { rule, until: values.until });
    }
    if (values.count !== undefined) {
      return t('repeat.endsAfter', { rule, count: values.count });
    }
    return rule;
  })();

  const respond = async (response: 'accepted' | 'tentative' | 'declined') => {
    setBusy(true);
    try {
      await calendarFetch(`/api/calendar/events/${item.id}/response`, {
        method: 'PUT',
        body: { response },
      });
      toast.success(t(`popover.responded.${response}`));
      onChanged();
      onClose();
    } catch (err) {
      toast.error(t('popover.saveFailed', { reason: errorText(err) }));
      setBusy(false);
    }
  };

  const currentReminders = reminders ?? ev?.reminders ?? [];
  const toggleNotify = async (minutes: number) => {
    const response = actions.myResponse;
    if (!response || response === 'pending') return;
    const before = currentReminders;
    const next = toggleReminder(before, minutes);
    setReminders(next);
    try {
      await calendarFetch(`/api/calendar/events/${item.id}/response`, {
        method: 'PUT',
        body: { response, reminders: next },
      });
    } catch (err) {
      setReminders(before);
      toast.error(t('popover.saveFailed', { reason: errorText(err) }));
    }
  };

  const kindLabel =
    item.kind === 'meeting'
      ? t('popover.meeting')
      : item.kind === 'task'
        ? t('task')
        : null;
  const location = ev
    ? ev.location
    : item.kind === 'event'
      ? item.location
      : null;
  const description = ev?.description?.trim() || null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="mt-1.5 size-2.5 shrink-0 rounded-full"
          style={{ background: colorVar(ev?.color ?? item.color, 'solid') }}
        />
        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-base font-medium break-words">
            {ev?.title ?? item.title}
          </h2>
          {kindLabel && (
            <p className="text-muted-foreground text-xs">{kindLabel}</p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('popover.close')}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>

      <Row icon={Clock}>
        <div>{whenText(item, zone, locale)}</div>
        {item.allDay && (
          <div className="text-muted-foreground text-xs">{t('allDay')}</div>
        )}
      </Row>
      {repeat && <Row icon={Repeat}>{repeat}</Row>}
      {location && <Row icon={MapPin}>{location}</Row>}

      {loading && (
        <div className="flex flex-col gap-2" aria-busy="true">
          <span className="sr-only">{t('loading')}</span>
          <div className="bg-muted h-3 w-3/4 animate-pulse rounded" />
          <div className="bg-muted h-3 w-1/2 animate-pulse rounded" />
          <div className="bg-muted h-3 w-2/3 animate-pulse rounded" />
        </div>
      )}
      {loadError && (
        <p className="text-destructive text-xs">
          {t('popover.loadFailed', { reason: loadError })}
        </p>
      )}

      {ev && detail && (
        <Row icon={Users}>
          <ul className="flex flex-col gap-1">
            <li className="flex items-center gap-1.5">
              <span className="truncate">{personName(ev.created_by)}</span>
              <span className="text-muted-foreground text-xs">
                {t('popover.organiser')}
              </span>
            </li>
            {detail.attendees.map((a) => {
              const Icon = RESPONSE_ICON[a.response];
              const label = t(`popover.responses.${a.response}`);
              return (
                <li key={a.user_id} className="flex items-center gap-1.5">
                  <Icon
                    aria-label={label}
                    className={cn(
                      'size-3.5 shrink-0',
                      RESPONSE_TONE[a.response]
                    )}
                  />
                  <span className="truncate" title={label}>
                    {personName(a.user_id)}
                  </span>
                </li>
              );
            })}
          </ul>
        </Row>
      )}

      {description && (
        <p className="text-muted-foreground max-h-40 overflow-y-auto break-words whitespace-pre-wrap">
          {descriptionParts(description).map((part, i) =>
            part.type === 'link' ? (
              <a
                key={i}
                href={part.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2"
              >
                {part.text}
              </a>
            ) : (
              <span key={i}>{part.text}</span>
            )
          )}
        </p>
      )}

      {actions.rsvp && (
        <div className="flex flex-col gap-1.5 border-t pt-3">
          <span className="text-muted-foreground text-xs">
            {t('popover.rsvpPrompt')}
          </span>
          <div className="flex gap-1.5">
            {(['accepted', 'tentative', 'declined'] as const).map((r) => (
              <Button
                key={r}
                size="sm"
                variant={actions.myResponse === r ? 'default' : 'outline'}
                aria-pressed={actions.myResponse === r}
                disabled={busy}
                onClick={() => respond(r)}
              >
                {t(`popover.rsvp.${r}`)}
              </Button>
            ))}
          </div>
        </div>
      )}

      {actions.notify && (
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground flex items-center gap-1 text-xs">
            <Bell className="size-3.5" />
            {t('popover.notifyMe')}
          </span>
          <div className="flex flex-wrap gap-1">
            {REMINDER_PRESETS.map((m) => {
              const on = currentReminders.includes(m);
              const { key, count } = reminderLabel(m);
              return (
                <Button
                  key={m}
                  size="xs"
                  variant={on ? 'secondary' : 'outline'}
                  aria-pressed={on}
                  onClick={() => toggleNotify(m)}
                >
                  {t(`reminders.${key}`, { count })}
                </Button>
              );
            })}
          </div>
        </div>
      )}

      {(actions.edit ||
        actions.remove ||
        actions.join ||
        actions.meetingId ||
        actions.contactId) && (
        <div className="flex flex-wrap justify-end gap-1.5 border-t pt-3">
          {actions.contactId && (
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href={`/contacts/${actions.contactId}`} />}
            >
              {t('popover.openContact')}
            </Button>
          )}
          {actions.meetingId && (
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href={`/meetings/${actions.meetingId}`} />}
            >
              {t('popover.openMeeting')}
            </Button>
          )}
          {actions.join && actions.meetingId && (
            <Button
              size="sm"
              nativeButton={false}
              render={<Link href={`/meetings/${actions.meetingId}/room`} />}
            >
              {t('popover.join')}
            </Button>
          )}
          {actions.remove && ev && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onDelete(item, ev.updated_at)}
            >
              <Trash2 className="size-4" />
              {t('popover.delete')}
            </Button>
          )}
          {actions.edit && (
            <Button size="sm" onClick={() => onEdit(item)}>
              <Pencil className="size-4" />
              {t('popover.edit')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
