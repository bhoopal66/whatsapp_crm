'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Video, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { PersonAvatar } from '@/components/meetings/person-avatars';
import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { useAuth } from '@/hooks/use-auth';
import { useMediaQuery } from '@/hooks/use-media-query';
import {
  INTERVAL_MAX,
  COUNT_MAX,
  WEEKDAYS,
  type RepeatDescription,
  type RepeatEnds,
  type RepeatForm,
} from '@/lib/calendar/rrule-form';
import { paletteCss, safeColor } from '@/lib/calendar/ui/colors';
import {
  attendeeCandidates,
  choiceDescription,
  formChanged,
  meetingStartOf,
  repeatChoiceOf,
  repeatChoices,
  repeatPreview,
  timeZoneChoices,
  withRepeatChoice,
  type RepeatChoice,
} from '@/lib/calendar/ui/event-dialog';
import {
  createBody,
  defaultEventForm,
  editBody,
  formFromEvent,
  formFromSelection,
  withAllDay,
  withStart,
  type BodyResult,
  type EventFormValues,
  type FormErrors,
  type FormField,
} from '@/lib/calendar/ui/event-form';
import { repeatValues } from '@/lib/calendar/ui/popover-format';
import {
  parseCustomReminder,
  REMINDER_PRESETS,
  reminderLabel,
  toggleReminder,
} from '@/lib/calendar/ui/reminder-chips';
import {
  DESCRIPTION_MAX,
  EVENT_COLORS,
  EVENT_VISIBILITIES,
  LOCATION_MAX,
  REMINDERS_MAX,
  TITLE_MAX,
  type EventVisibility,
} from '@/lib/calendar/validate';
import { cn } from '@/lib/utils';

import {
  calendarFetch,
  errorStatus,
  errorText,
  type EventDetail,
} from './calendar-api';
import type { EditorRequest } from './calendar-page';

const SCOPE = '.cal-event-dialog';
const DIALOG_CSS = paletteCss(SCOPE);
// Native date/time pickers follow the app's mode, not the OS's.
const NATIVE_INPUT = '[color-scheme:light] dark:[color-scheme:dark]';

/**
 * Create or edit a calendar event. Mount it with a fresh `key` per
 * request: it reads the request once. Full-screen sheet on a phone.
 */
export function EventDialog({
  request,
  zone,
  onClose,
  onSaved,
  onVideoMeeting,
}: {
  request: EditorRequest;
  /** The account's zone: a new event's default. */
  zone: string;
  onClose: () => void;
  /** After a successful save (the dialog closes itself). */
  onSaved: () => void;
  /**
   * "Video meeting instead": this dialog is closed by the parent.
   * Omitted for someone who cannot create meetings (below team leader).
   */
  onVideoMeeting?: (start: Date | undefined) => void;
}) {
  const t = useTranslations('Calendar');
  const locale = useLocale();
  const narrow = useMediaQuery('(max-width: 640px)');
  const { user } = useAuth();
  const { members, nameOf, avatarOf } = useWorkspaceMembers();
  const editing = request.mode === 'edit';
  const item = request.mode === 'edit' ? request.item : null;
  const scope = request.mode === 'edit' ? request.scope : 'all';
  const occurrenceOnly = editing && scope === 'this';

  const [values, setValues] = useState<EventFormValues | null>(() => {
    if (request.mode === 'edit') return null;
    const r = request.range;
    return r
      ? formFromSelection(r.start, r.end, r.allDay, zone)
      : defaultEventForm(new Date(), zone);
  });
  const [initial, setInitial] = useState<EventFormValues | null>(values);
  const [organizerId, setOrganizerId] = useState<string | null>(null);
  // The event's updated_at as loaded: a save is refused (409) if it moved.
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [search, setSearch] = useState('');
  const [customReminder, setCustomReminder] = useState('');
  const [customInvalid, setCustomInvalid] = useState(false);

  const load = useCallback(async () => {
    if (!item) return;
    try {
      const detail = await calendarFetch<EventDetail>(
        `/api/calendar/events/${item.id}`
      );
      const ev = detail.event;
      const visibility = (EVENT_VISIBILITIES as readonly string[]).includes(
        ev.visibility
      )
        ? (ev.visibility as EventVisibility)
        : 'attendees';
      const form = formFromEvent(
        { ...ev, color: safeColor(ev.color), visibility },
        detail.attendees.map((a) => a.user_id),
        scope === 'this' ? { start: item.start, end: item.end } : undefined
      );
      setOrganizerId(ev.created_by);
      setLoadedAt(ev.updated_at);
      setValues(form);
      setInitial(form);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, [item, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const build = (v: EventFormValues): BodyResult =>
    item && initial
      ? editBody(v, {
          original: initial,
          scope,
          occurrenceStart: item.occurrenceStart,
        })
      : createBody(v);

  const built = values && attempted ? build(values) : null;
  const errors: FormErrors = built && !built.ok ? built.errors : {};
  const dirty = !!values && !!initial && formChanged(values, initial);

  const requestClose = () => {
    if (saving) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const submit = async () => {
    if (!values || saving) return;
    setAttempted(true);
    const result = build(values);
    if (!result.ok) return;
    if (item && Object.keys(result.body).length === 0) return onClose();
    setSaving(true);
    try {
      await calendarFetch(
        item ? `/api/calendar/events/${item.id}` : '/api/calendar/events',
        item
          ? {
              method: 'PATCH',
              body: { ...result.body, expectedUpdatedAt: loadedAt },
            }
          : { method: 'POST', body: result.body }
      );
      toast.success(item ? t('form.saved') : t('form.created'));
      onSaved();
      onClose();
    } catch (err) {
      if (errorStatus(err) === 409) {
        toast.error(t('form.conflict'));
        await load();
      } else {
        toast.error(t('form.saveFailed', { reason: errorText(err) }));
      }
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof EventFormValues>(
    key: K,
    value: EventFormValues[K]
  ) => setValues((v) => (v ? { ...v, [key]: value } : v));
  const setRepeat = (patch: Partial<RepeatForm>) =>
    setValues((v) => (v ? { ...v, repeat: { ...v.repeat, ...patch } } : v));

  const repeatText = (desc: RepeatDescription) => {
    const v = repeatValues(desc, locale);
    const rule = t(`repeat.${desc.key}`, v);
    if (v.until !== undefined) {
      return t('repeat.endsOn', { rule, until: v.until });
    }
    if (v.count !== undefined) {
      return t('repeat.endsAfter', { rule, count: v.count });
    }
    return rule;
  };

  const fieldError = (field: FormField) =>
    errors[field] ? (
      <p className="text-destructive text-xs" role="alert">
        {t(`form.errors.${errors[field]}`)}
      </p>
    ) : null;

  const addCustom = () => {
    if (!values) return;
    const m = parseCustomReminder(customReminder);
    if (m === null) return setCustomInvalid(true);
    if (!values.reminders.includes(m)) {
      set('reminders', toggleReminder(values.reminders, m));
    }
    setCustomReminder('');
  };

  const title = editing ? t('form.editTitle') : t('form.createTitle');

  const body = !values ? (
    <p className="text-muted-foreground py-8 text-center text-sm">
      {loadError
        ? t('form.loadFailed', { reason: loadError })
        : t('form.loading')}
    </p>
  ) : (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <style>{DIALOG_CSS}</style>
      <Field id="event-title" label={t('form.title')}>
        <Input
          id="event-title"
          value={values.title}
          maxLength={TITLE_MAX}
          placeholder={t('form.titlePlaceholder')}
          onChange={(e) => set('title', e.target.value)}
          aria-invalid={!!errors.title}
          autoFocus
        />
        {fieldError('title')}
      </Field>

      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="event-all-day">{t('form.allDay')}</Label>
        <Switch
          id="event-all-day"
          checked={values.allDay}
          onCheckedChange={(on) =>
            setValues((v) => (v ? withAllDay(v, on) : v))
          }
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-sm font-medium">
            {t('form.start')}
          </legend>
          <div className="flex gap-2">
            <Input
              type="date"
              aria-label={t('form.startDate')}
              className={NATIVE_INPUT}
              value={values.startDate}
              onChange={(e) =>
                setValues((v) =>
                  v ? withStart(v, e.target.value, v.startTime) : v
                )
              }
              aria-invalid={!!errors.start}
            />
            {!values.allDay && (
              <Input
                type="time"
                aria-label={t('form.startTime')}
                className={cn('w-32', NATIVE_INPUT)}
                value={values.startTime}
                onChange={(e) =>
                  setValues((v) =>
                    v ? withStart(v, v.startDate, e.target.value) : v
                  )
                }
                aria-invalid={!!errors.start}
              />
            )}
          </div>
          {fieldError('start')}
        </fieldset>
        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-sm font-medium">
            {t('form.end')}
          </legend>
          <div className="flex gap-2">
            <Input
              type="date"
              aria-label={t('form.endDate')}
              className={NATIVE_INPUT}
              value={values.endDate}
              onChange={(e) => set('endDate', e.target.value)}
              aria-invalid={!!errors.end}
            />
            {!values.allDay && (
              <Input
                type="time"
                aria-label={t('form.endTime')}
                className={cn('w-32', NATIVE_INPUT)}
                value={values.endTime}
                onChange={(e) => set('endTime', e.target.value)}
                aria-invalid={!!errors.end}
              />
            )}
          </div>
          {fieldError('end')}
        </fieldset>
      </div>

      {!values.allDay && (
        <Field label={t('form.timeZone')}>
          <Select
            value={values.timeZone}
            onValueChange={(z) => z && set('timeZone', z as string)}
          >
            <SelectTrigger className="w-full" aria-label={t('form.timeZone')}>
              <SelectValue>{values.timeZone}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {timeZoneChoices(zone, values.timeZone).map((z) => (
                <SelectItem key={z} value={z}>
                  {z}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      {occurrenceOnly ? (
        <p className="text-muted-foreground text-sm">
          {t('form.thisOccurrenceOnly')}
        </p>
      ) : (
        <RepeatPicker
          values={values}
          locale={locale}
          setValues={setValues}
          setRepeat={setRepeat}
          repeatText={repeatText}
          error={fieldError('repeat')}
        />
      )}

      <Field id="event-attendee-search" label={t('form.attendees')}>
        {values.attendees.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {values.attendees.map((id) => {
              const name = nameOf(id) ?? t('form.unknownPerson');
              return (
                <li
                  key={id}
                  className="bg-muted flex items-center gap-1.5 rounded-full py-0.5 pr-1 pl-0.5 text-xs"
                >
                  <PersonAvatar
                    size="sm"
                    person={{ userId: id, name, avatarUrl: avatarOf(id) }}
                  />
                  <span className="max-w-40 truncate">{name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('form.removeAttendee', { name })}
                    onClick={() =>
                      set(
                        'attendees',
                        values.attendees.filter((a) => a !== id)
                      )
                    }
                  >
                    <X className="size-3" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <AttendeeSearch
          search={search}
          setSearch={setSearch}
          candidates={attendeeCandidates(members, search, values.attendees, [
            organizerId ?? user?.id,
          ])}
          onAdd={(id) => {
            set('attendees', [...values.attendees, id]);
            setSearch('');
          }}
        />
      </Field>

      <Field id="event-location" label={t('form.location')}>
        <Input
          id="event-location"
          value={values.location}
          maxLength={LOCATION_MAX}
          placeholder={t('form.locationPlaceholder')}
          onChange={(e) => set('location', e.target.value)}
        />
        {fieldError('location')}
      </Field>

      <Field id="event-description" label={t('form.description')}>
        <Textarea
          id="event-description"
          rows={3}
          value={values.description}
          maxLength={DESCRIPTION_MAX}
          placeholder={t('form.descriptionPlaceholder')}
          onChange={(e) => set('description', e.target.value)}
        />
        {fieldError('description')}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('form.color')}>
          <RadioGroup
            aria-label={t('form.color')}
            value={values.color}
            onValueChange={(c) => set('color', safeColor(c))}
            className="flex flex-wrap gap-2"
          >
            {EVENT_COLORS.map((c) => (
              <RadioGroupItem
                key={c}
                value={c}
                aria-label={t(`form.colors.${c}`)}
                title={t(`form.colors.${c}`)}
                className="ring-offset-background data-checked:ring-ring size-6 border-0 ring-offset-2 data-checked:ring-2"
                style={{ background: `var(--cal-${c})` }}
              />
            ))}
          </RadioGroup>
        </Field>
        <Field label={t('form.visibility')}>
          <Select
            value={values.visibility}
            onValueChange={(x) => x && set('visibility', x as EventVisibility)}
          >
            <SelectTrigger className="w-full" aria-label={t('form.visibility')}>
              <SelectValue>
                {t(`form.visibilityOptions.${values.visibility}`)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {EVENT_VISIBILITIES.map((x) => (
                <SelectItem key={x} value={x}>
                  {t(`form.visibilityOptions.${x}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            {t(`form.visibilityHints.${values.visibility}`)}
          </p>
        </Field>
      </div>

      <Field id="event-reminder-custom" label={t('form.reminders')}>
        <div className="flex flex-wrap gap-1.5">
          {[...new Set([...REMINDER_PRESETS, ...values.reminders])]
            .sort((a, b) => a - b)
            .map((m) => {
              const on = values.reminders.includes(m);
              const { key, count } = reminderLabel(m);
              return (
                <Button
                  key={m}
                  type="button"
                  size="xs"
                  variant={on ? 'secondary' : 'outline'}
                  aria-pressed={on}
                  disabled={!on && values.reminders.length >= REMINDERS_MAX}
                  onClick={() =>
                    set('reminders', toggleReminder(values.reminders, m))
                  }
                >
                  {t(`reminders.${key}`, { count })}
                </Button>
              );
            })}
        </div>
        <div className="flex gap-2">
          <Input
            id="event-reminder-custom"
            value={customReminder}
            placeholder={t('form.reminderCustom')}
            className="max-w-48"
            onChange={(e) => {
              setCustomReminder(e.target.value);
              setCustomInvalid(false);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              addCustom();
            }}
            aria-invalid={customInvalid}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              !customReminder.trim() || values.reminders.length >= REMINDERS_MAX
            }
            onClick={addCustom}
          >
            {t('form.reminderAdd')}
          </Button>
        </div>
        {customInvalid && (
          <p className="text-destructive text-xs" role="alert">
            {t('form.reminderInvalid')}
          </p>
        )}
        {values.reminders.length >= REMINDERS_MAX && (
          <p className="text-muted-foreground text-xs">
            {t('form.remindersMax', { max: REMINDERS_MAX })}
          </p>
        )}
        {fieldError('reminders')}
      </Field>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        {!editing && onVideoMeeting ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onVideoMeeting(meetingStartOf(values))}
          >
            <Video className="size-4" />
            {t('form.videoInstead')}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={requestClose}>
            {t('form.cancel')}
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? t('form.saving') : t('form.save')}
          </Button>
        </div>
      </div>
    </form>
  );

  const discard = (
    <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('form.discardTitle')}</DialogTitle>
          <DialogDescription>{t('form.discardBody')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmDiscard(false)}>
            {t('form.keepEditing')}
          </Button>
          <Button variant="destructive" onClick={onClose}>
            {t('form.discard')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const onOpenChange = (open: boolean) => {
    if (!open) requestClose();
  };

  if (narrow) {
    return (
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="cal-event-dialog h-dvh max-h-dvh gap-3 overflow-y-auto p-4"
        >
          <SheetTitle>{title}</SheetTitle>
          {body}
          {discard}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="cal-event-dialog max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {body}
        {discard}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id?: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function AttendeeSearch({
  search,
  setSearch,
  candidates,
  onAdd,
}: {
  search: string;
  setSearch: (s: string) => void;
  candidates: {
    user_id: string;
    full_name: string | null;
    email: string | null;
    avatar_url?: string | null;
  }[];
  onAdd: (userId: string) => void;
}) {
  const t = useTranslations('Calendar.form');
  return (
    <div className="space-y-1">
      <Input
        id="event-attendee-search"
        value={search}
        placeholder={t('attendeesSearch')}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (candidates[0]) onAdd(candidates[0].user_id);
        }}
      />
      {search.trim() && (
        <ul className="max-h-48 overflow-y-auto rounded-md border">
          {candidates.length === 0 ? (
            <li className="text-muted-foreground p-2 text-xs">
              {t('attendeesEmpty')}
            </li>
          ) : (
            candidates.map((p) => {
              const name = p.full_name || p.email || '';
              return (
                <li key={p.user_id}>
                  <button
                    type="button"
                    className="hover:bg-muted flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm"
                    onClick={() => onAdd(p.user_id)}
                  >
                    <PersonAvatar
                      size="sm"
                      person={{
                        userId: p.user_id,
                        name,
                        avatarUrl: p.avatar_url ?? null,
                      }}
                    />
                    <span className="truncate">{name}</span>
                    {p.email && p.full_name && (
                      <span className="text-muted-foreground truncate text-xs">
                        {p.email}
                      </span>
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}

const INTERVAL_UNIT = {
  daily: 'days',
  weekly: 'weeks',
  monthly: 'months',
  yearly: 'years',
} as const;

function RepeatPicker({
  values,
  locale,
  setValues,
  setRepeat,
  repeatText,
  error,
}: {
  values: EventFormValues;
  locale: string;
  setValues: (f: (v: EventFormValues | null) => EventFormValues | null) => void;
  setRepeat: (patch: Partial<RepeatForm>) => void;
  repeatText: (desc: RepeatDescription) => string;
  error: ReactNode;
}) {
  const t = useTranslations('Calendar');
  const choice = repeatChoiceOf(values);
  const r = values.repeat;
  const label = (c: RepeatChoice) => {
    const desc = choiceDescription(values, c);
    return desc ? repeatText(desc) : t(`form.repeatOptions.${c}`);
  };
  const preview = repeatPreview(values);
  const dayName = (i: number) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      weekday: 'short',
    }).format(new Date(Date.UTC(2024, 0, 1 + i)));
  const showDetails = choice !== 'none' && choice !== 'custom';

  return (
    <div className="space-y-2">
      <Label>{t('form.repeat')}</Label>
      <Select
        value={choice}
        onValueChange={(c) =>
          c &&
          setValues((v) => (v ? withRepeatChoice(v, c as RepeatChoice) : v))
        }
      >
        <SelectTrigger className="w-full" aria-label={t('form.repeat')}>
          <SelectValue>{label(choice)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {repeatChoices(values).map((c) => (
            <SelectItem key={c} value={c} disabled={c === 'custom'}>
              {label(c)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {showDetails && (
        <div className="bg-muted/40 space-y-3 rounded-md border p-3">
          <div className="flex items-center gap-2 text-sm">
            <Label htmlFor="event-repeat-interval">{t('form.every')}</Label>
            <Input
              id="event-repeat-interval"
              type="number"
              min={1}
              max={INTERVAL_MAX}
              className="w-20"
              value={r.interval || ''}
              onChange={(e) => setRepeat({ interval: Number(e.target.value) })}
            />
            <span>
              {t(
                `form.intervalUnit.${INTERVAL_UNIT[r.freq as keyof typeof INTERVAL_UNIT]}`,
                {
                  count: r.interval || 0,
                }
              )}
            </span>
          </div>

          {r.freq === 'weekly' && (
            <div
              className="flex flex-wrap gap-1"
              role="group"
              aria-label={t('form.onDays')}
            >
              {WEEKDAYS.map((d, i) => {
                const on = r.weekdays.includes(d);
                return (
                  <Button
                    key={d}
                    type="button"
                    size="xs"
                    variant={on ? 'default' : 'outline'}
                    aria-pressed={on}
                    onClick={() =>
                      setRepeat({
                        weekdays: on
                          ? r.weekdays.filter((x) => x !== d)
                          : [...r.weekdays, d],
                      })
                    }
                  >
                    {dayName(i)}
                  </Button>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{t('form.ends')}</span>
            <Select
              value={r.ends}
              onValueChange={(x) => {
                const ends = x as RepeatEnds;
                setRepeat({
                  ends,
                  until:
                    ends === 'on' ? (r.until ?? values.startDate) : r.until,
                  count: ends === 'after' ? (r.count ?? 10) : r.count,
                });
              }}
            >
              <SelectTrigger className="w-36" aria-label={t('form.ends')}>
                <SelectValue>{t(`form.endsOptions.${r.ends}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(['never', 'on', 'after'] as const).map((x) => (
                  <SelectItem key={x} value={x}>
                    {t(`form.endsOptions.${x}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {r.ends === 'on' && (
              <Input
                type="date"
                aria-label={t('form.untilLabel')}
                className={cn('w-44', NATIVE_INPUT)}
                min={values.startDate}
                value={r.until ?? ''}
                onChange={(e) => setRepeat({ until: e.target.value || null })}
              />
            )}
            {r.ends === 'after' && (
              <>
                <Input
                  type="number"
                  aria-label={t('form.countLabel')}
                  min={1}
                  max={COUNT_MAX}
                  className="w-20"
                  value={r.count ?? ''}
                  onChange={(e) =>
                    setRepeat({
                      count: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                />
                <span>{t('form.occurrences', { count: r.count ?? 0 })}</span>
              </>
            )}
          </div>
        </div>
      )}

      <p className="text-muted-foreground text-xs" aria-live="polite">
        {choice === 'custom'
          ? t('form.repeatOptions.custom')
          : preview === 'invalid'
            ? t('form.repeatPreviewInvalid')
            : preview === 'none'
              ? t('form.repeatOptions.none')
              : repeatText(preview)}
      </p>
      {error}
    </div>
  );
}
