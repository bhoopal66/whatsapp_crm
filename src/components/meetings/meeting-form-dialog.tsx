'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import {
  buildMeetingBody,
  defaultMeetingForm,
  DESCRIPTION_MAX,
  MEETING_DURATIONS,
  meetingToForm,
  parseMeeting,
  TITLE_MAX,
  type MeetingFormError,
  type MeetingFormValues,
  type MeetingSummary,
} from '@/lib/meetings/schedule';

import { useWorkspaceMembers } from './use-workspace-members';

/**
 * New meeting (POST /api/meetings) and Edit (PATCH /api/meetings/[id]).
 * Start now creates an instant meeting and goes straight to its room.
 * Give it a new `key` each time it opens, so it starts from the
 * meeting as it is then.
 */
export function MeetingFormDialog({
  open,
  onOpenChange,
  meeting,
  timeZone,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set to edit this meeting; omitted to create one. */
  meeting?: MeetingSummary;
  /** The zone the date and time fields are read in (read at opening). */
  timeZone: string;
  onSaved?: (m: MeetingSummary | null) => void;
}) {
  const t = useTranslations('Meetings.form');
  const router = useRouter();
  const { user } = useAuth();
  const { members } = useWorkspaceMembers();
  const editing = !!meeting;

  // Read once: the parent remounts this (a fresh `key`) per opening.
  const [values, setValues] = useState<MeetingFormValues>(() =>
    meeting
      ? meetingToForm(meeting, new Date(), timeZone)
      : defaultMeetingForm(new Date(), timeZone)
  );
  const [errors, setErrors] = useState<MeetingFormError[]>([]);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof MeetingFormValues>(
    key: K,
    value: MeetingFormValues[K]
  ) => setValues((v) => ({ ...v, [key]: value }));

  // Live staff other than the host; the database refuses anyone else.
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members.filter(
      (p) =>
        !p.deactivated_at &&
        p.user_id !== (meeting?.hostUserId ?? user?.id) &&
        (!q ||
          (p.full_name ?? '').toLowerCase().includes(q) ||
          (p.email ?? '').toLowerCase().includes(q))
    );
  }, [members, search, meeting?.hostUserId, user?.id]);

  const toggleInvitee = (userId: string, on: boolean) =>
    set(
      'inviteeUserIds',
      on
        ? [...values.inviteeUserIds, userId]
        : values.inviteeUserIds.filter((id) => id !== userId)
    );

  const submit = async () => {
    const built = buildMeetingBody(values, {
      timeZone,
      now: new Date(),
      allowPast: editing,
    });
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      const res = await fetch(
        editing ? `/api/meetings/${meeting.id}` : '/api/meetings',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(built.body),
        }
      );
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json().catch(() => null)) as {
        meeting?: unknown;
        id?: unknown;
      } | null;
      const saved = parseMeeting(json?.meeting ?? json);
      onOpenChange(false);
      onSaved?.(saved);
      if (!editing && values.startNow && saved) {
        router.push(`/meetings/${saved.id}/room`);
      } else if (!editing && saved) {
        router.push(`/meetings/${saved.id}`);
      }
    } catch {
      toast.error(t('errors.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const fieldError = (keys: MeetingFormError[]) => {
    const hit = errors.find((e) => keys.includes(e));
    return hit ? (
      <p className="text-destructive text-xs">{t(`errors.${hit}`)}</p>
    ) : null;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? t('editTitle') : t('createTitle')}
          </DialogTitle>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="meeting-title">{t('title')}</Label>
            <Input
              id="meeting-title"
              value={values.title}
              maxLength={TITLE_MAX}
              placeholder={t('titlePlaceholder')}
              onChange={(e) => set('title', e.target.value)}
              autoFocus
            />
            {fieldError(['titleRequired', 'titleTooLong'])}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="meeting-description">{t('description')}</Label>
            <Textarea
              id="meeting-description"
              value={values.description}
              maxLength={DESCRIPTION_MAX}
              rows={2}
              placeholder={t('descriptionPlaceholder')}
              onChange={(e) => set('description', e.target.value)}
            />
            {fieldError(['descriptionTooLong'])}
          </div>

          {!editing && (
            <div className="flex items-start justify-between gap-3">
              <div>
                <Label htmlFor="meeting-start-now">{t('startNow')}</Label>
                <p className="text-muted-foreground text-xs">
                  {t('startNowHint')}
                </p>
              </div>
              <Switch
                id="meeting-start-now"
                checked={values.startNow}
                onCheckedChange={(v) => set('startNow', !!v)}
              />
            </div>
          )}

          {!values.startNow && (
            <div className="space-y-1.5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="meeting-date">{t('date')}</Label>
                  <Input
                    id="meeting-date"
                    type="date"
                    value={values.date}
                    onChange={(e) => set('date', e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="meeting-time">{t('time')}</Label>
                  <Input
                    id="meeting-time"
                    type="time"
                    step={300}
                    value={values.time}
                    onChange={(e) => set('time', e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t('duration')}</Label>
                  <Select
                    value={String(values.durationMinutes)}
                    onValueChange={(v) =>
                      v && set('durationMinutes', Number(v))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>
                        {t('durationMinutes', {
                          minutes: values.durationMinutes,
                        })}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {[
                        ...new Set([
                          ...MEETING_DURATIONS,
                          values.durationMinutes,
                        ]),
                      ]
                        .sort((a, b) => a - b)
                        .map((m) => (
                          <SelectItem key={m} value={String(m)}>
                            {t('durationMinutes', { minutes: m })}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {fieldError([
                'dateRequired',
                'timeRequired',
                'invalidDateTime',
                'startInPast',
                'durationInvalid',
              ])}
              <p className="text-muted-foreground text-xs">
                {t('timeZoneNote', { zone: timeZone })}
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor="meeting-invitee-search">{t('invitees')}</Label>
              <span className="text-muted-foreground text-xs">
                {t('invitedCount', { count: values.inviteeUserIds.length })}
              </span>
            </div>
            <Input
              id="meeting-invitee-search"
              value={search}
              placeholder={t('inviteesSearch')}
              onChange={(e) => setSearch(e.target.value)}
            />
            <ul className="border-border max-h-40 overflow-y-auto rounded-lg border">
              {candidates.length === 0 ? (
                <li className="text-muted-foreground px-3 py-2 text-xs">
                  {t('inviteesEmpty')}
                </li>
              ) : (
                candidates.map((p) => {
                  const checked = values.inviteeUserIds.includes(p.user_id);
                  return (
                    <li key={p.user_id}>
                      <label className="hover:bg-muted flex cursor-pointer items-center gap-2 px-3 py-1.5">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) => toggleInvitee(p.user_id, !!v)}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {p.full_name || p.email}
                        </span>
                      </label>
                    </li>
                  );
                })
              )}
            </ul>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div>
              <Label htmlFor="meeting-open">{t('openToWorkspace')}</Label>
              <p className="text-muted-foreground text-xs">
                {t('openToWorkspaceHint')}
              </p>
            </div>
            <Switch
              id="meeting-open"
              checked={values.openToWorkspace}
              onCheckedChange={(v) => set('openToWorkspace', !!v)}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving
                ? t('saving')
                : editing
                  ? t('save')
                  : values.startNow
                    ? t('createAndJoin')
                    : t('create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
