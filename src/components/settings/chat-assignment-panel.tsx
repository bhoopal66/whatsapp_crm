'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { AssignmentPeoplePicker } from '@/components/assignment/people-picker';
import { ErrorState } from '@/components/dashboard/error-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { invalidateCached } from '@/lib/client-cache';
import {
  ASSIGNMENT_SETTINGS_DEFAULTS,
  type AssignmentSettings,
} from '@/lib/assignment/types';
import {
  MAX_CHAT_LIMIT,
  MIN_CHAT_LIMIT,
  assignmentSettingsDiff,
  knownAssignmentError,
  parseChatLimit,
  rotationPeople,
} from '@/lib/assignment/ui';
import { MEMBER_LOADS_CACHE_PREFIX } from '@/hooks/use-member-loads';
import { readSettings } from '@/lib/settings/read-settings';
import { SettingsPanelHead } from './settings-panel-head';

interface MemberRow {
  userId: string;
  name: string;
  role: string;
  deactivated: boolean;
  openCount: number;
  /** The person's own limit; null = the default applies. */
  limit: number | null;
}

function parseSettings(raw: unknown): AssignmentSettings {
  const s = (raw ?? {}) as Partial<AssignmentSettings>;
  const d = ASSIGNMENT_SETTINGS_DEFAULTS;
  return {
    broadcastRotationEnabled: s.broadcastRotationEnabled === true,
    broadcastPool: Array.isArray(s.broadcastPool)
      ? s.broadcastPool.filter((u): u is string => typeof u === 'string')
      : [],
    compassAssignEnabled: s.compassAssignEnabled === true,
    limitsEnabled: s.limitsEnabled === true,
    defaultChatLimit:
      parseChatLimit(s.defaultChatLimit ?? '') ?? d.defaultChatLimit,
  };
}

/**
 * Settings -> Inbox & CRM -> Chat assignment (migration 236): who gets
 * the first reply to a broadcast, Compass chats to the case's agent,
 * and chat limits. Everything is off by default. GET / PUT
 * /api/assignment/settings and PUT / DELETE
 * /api/assignment/limits/[userId], owner/admin only (the section's
 * gate, the routes and the SQL writers).
 */
export function ChatAssignmentPanel() {
  const t = useTranslations('ChatAssignment');
  const { accountId } = useAuth();
  // What was loaded (or last saved), and the form over it: a save sends
  // only the difference.
  const [saved, setSaved] = useState<AssignmentSettings | null>(null);
  const [form, setForm] = useState<AssignmentSettings | null>(null);
  const [limitText, setLimitText] = useState('');
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [available, setAvailable] = useState(true);
  const [saving, setSaving] = useState(false);
  // Per-person limits save on their own, one row at a time.
  const [rowText, setRowText] = useState<Record<string, string>>({});
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [addPerson, setAddPerson] = useState('');
  const [addText, setAddText] = useState('');
  // A failed load keeps the form empty: the defaults must never be
  // savable over settings that were not read.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      try {
        const body = await readSettings('/api/assignment/settings');
        if (cancelled) return;
        const s = parseSettings(body.settings);
        setSaved(s);
        setForm(s);
        setLimitText(String(s.defaultChatLimit));
        setMembers(Array.isArray(body.members) ? body.members : []);
        setAvailable(body.available !== false);
        setFailed(false);
      } catch {
        if (cancelled) return;
        setForm(null);
        setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, attempt]);

  const people = useMemo(
    () =>
      rotationPeople(
        members.map((m) => ({
          user_id: m.userId,
          full_name: m.name,
          role: m.role,
          deactivated_at: m.deactivated ? 'yes' : null,
        })),
        form?.broadcastPool ?? []
      ),
    [members, form?.broadcastPool]
  );

  const withLimit = members.filter((m) => m.limit !== null);
  const addable = members.filter(
    (m) => m.limit === null && !m.deactivated && m.role !== 'viewer'
  );

  const errorText = (code: unknown, fallback: string) => {
    const known = knownAssignmentError(code);
    return known ? t(`errors.${known}`) : fallback;
  };

  if (failed) {
    return (
      <div>
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <ErrorState
          message={t('loadFailed')}
          onRetry={() => {
            setFailed(false);
            setAttempt((n) => n + 1);
          }}
        />
      </div>
    );
  }
  if (!form || !saved) {
    return (
      <div>
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <Loader2 className="text-muted-foreground size-4 animate-spin" />
      </div>
    );
  }

  const defaultLimit = parseChatLimit(limitText);
  const changes = assignmentSettingsDiff(saved, {
    ...form,
    defaultChatLimit: defaultLimit ?? saved.defaultChatLimit,
  });
  const dirty = Object.keys(changes).length > 0;
  const canSave = available && dirty && defaultLimit !== null && !saving;

  const update = (patch: Partial<AssignmentSettings>) =>
    setForm({ ...form, ...patch });

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const res = await fetch('/api/assignment/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changes),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorText(body?.error, t('saveFailed')));
        return;
      }
      const s = parseSettings(body?.settings);
      setSaved(s);
      setForm(s);
      setLimitText(String(s.defaultChatLimit));
      invalidateCached(MEMBER_LOADS_CACHE_PREFIX);
      toast.success(t('saved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function writeLimit(userId: string, maxOpen: number | null) {
    setBusyRow(userId);
    try {
      const res = await fetch(
        `/api/assignment/limits/${encodeURIComponent(userId)}`,
        maxOpen === null
          ? { method: 'DELETE' }
          : {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ maxOpen }),
            }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorText(body?.error, t('limitFailed')));
        return false;
      }
      setMembers((list) =>
        list.map((m) => (m.userId === userId ? { ...m, limit: maxOpen } : m))
      );
      setRowText((r) => {
        const next = { ...r };
        delete next[userId];
        return next;
      });
      invalidateCached(MEMBER_LOADS_CACHE_PREFIX);
      toast.success(maxOpen === null ? t('limitRemoved') : t('limitSaved'));
      return true;
    } catch {
      toast.error(t('limitFailed'));
      return false;
    } finally {
      setBusyRow(null);
    }
  }

  const addLimit = parseChatLimit(addText);

  return (
    <div className="space-y-5">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {!available ? (
        <p className="border-border bg-card-2 text-muted-foreground rounded-lg border p-3 text-sm">
          {t('notAvailable')}
        </p>
      ) : null}

      {/* Broadcast first replies */}
      <section className="border-border bg-card space-y-4 rounded-lg border p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p
              id="ca-broadcast"
              className="text-foreground text-sm font-medium"
            >
              {t('broadcast.title')}
            </p>
            <p className="text-muted-foreground text-xs">
              {t('broadcast.hint')}
            </p>
          </div>
          <Switch
            checked={form.broadcastRotationEnabled}
            disabled={!available || saving}
            aria-labelledby="ca-broadcast"
            onCheckedChange={(on) => update({ broadcastRotationEnabled: on })}
          />
        </div>
        <div className="space-y-1">
          <p className="text-foreground text-sm font-medium">
            {t('broadcast.people')}
          </p>
          <AssignmentPeoplePicker
            people={people}
            value={form.broadcastPool}
            disabled={!available || saving}
            onChange={(next) => update({ broadcastPool: next })}
          />
        </div>
      </section>

      {/* Compass */}
      <section className="border-border bg-card flex items-start justify-between gap-4 rounded-lg border p-4">
        <div className="min-w-0">
          <p id="ca-compass" className="text-foreground text-sm font-medium">
            {t('compass.title')}
          </p>
          <p className="text-muted-foreground text-xs">{t('compass.hint')}</p>
        </div>
        <Switch
          checked={form.compassAssignEnabled}
          disabled={!available || saving}
          aria-labelledby="ca-compass"
          onCheckedChange={(on) => update({ compassAssignEnabled: on })}
        />
      </section>

      {/* Chat limits */}
      <section className="border-border bg-card space-y-4 rounded-lg border p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p id="ca-limits" className="text-foreground text-sm font-medium">
              {t('limits.title')}
            </p>
            <p className="text-muted-foreground text-xs">{t('limits.hint')}</p>
          </div>
          <Switch
            checked={form.limitsEnabled}
            disabled={!available || saving}
            aria-labelledby="ca-limits"
            onCheckedChange={(on) => update({ limitsEnabled: on })}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="ca-default-limit">{t('limits.default')}</Label>
          <div className="flex items-center gap-2">
            <Input
              id="ca-default-limit"
              inputMode="numeric"
              className="w-24"
              value={limitText}
              disabled={!available || saving}
              aria-invalid={defaultLimit === null}
              onChange={(e) => setLimitText(e.target.value)}
            />
            <span className="text-muted-foreground text-sm">
              {t('limits.openChats')}
            </span>
          </div>
          <p
            className={
              defaultLimit === null
                ? 'text-destructive text-xs'
                : 'text-muted-foreground text-xs'
            }
          >
            {defaultLimit === null
              ? t('errors.bad_limit')
              : t('limits.defaultHint')}
          </p>
        </div>

        <div className="space-y-2">
          <div>
            <h3 className="text-foreground text-sm font-medium">
              {t('limits.ownTitle')}
            </h3>
            <p className="text-muted-foreground text-xs">
              {t('limits.ownHint')}
            </p>
          </div>

          {withLimit.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t('limits.none')}</p>
          ) : (
            <ul className="border-border divide-border divide-y rounded-md border">
              {withLimit.map((m) => {
                const text = rowText[m.userId] ?? String(m.limit);
                const parsed = parseChatLimit(text);
                const changed = parsed !== null && parsed !== m.limit;
                const busy = busyRow === m.userId;
                return (
                  <li
                    key={m.userId}
                    className="flex flex-wrap items-center gap-2 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-foreground truncate text-sm">
                        {m.name}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {t('limits.openNow', { count: m.openCount })}
                      </p>
                    </div>
                    <Input
                      inputMode="numeric"
                      className="w-20"
                      value={text}
                      disabled={!available || busy}
                      aria-label={t('limits.limitFor', { name: m.name })}
                      aria-invalid={parsed === null}
                      onChange={(e) =>
                        setRowText((r) => ({
                          ...r,
                          [m.userId]: e.target.value,
                        }))
                      }
                    />
                    {changed ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={!available || busy}
                        onClick={() => void writeLimit(m.userId, parsed)}
                      >
                        {t('limits.update')}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={!available || busy}
                      aria-label={t('limits.remove', { name: m.name })}
                      onClick={() => void writeLimit(m.userId, null)}
                    >
                      {busy ? <Loader2 className="animate-spin" /> : <X />}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          {addable.length > 0 ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1 basis-48 space-y-1">
                <Label>{t('limits.person')}</Label>
                <Select
                  value={addPerson}
                  onValueChange={(v) => {
                    if (typeof v === 'string') setAddPerson(v);
                  }}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={t('limits.person')}
                  >
                    <SelectValue placeholder={t('limits.pickPerson')}>
                      {addable.find((m) => m.userId === addPerson)?.name ??
                        t('limits.pickPerson')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {addable.map((m) => (
                      <SelectItem key={m.userId} value={m.userId}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ca-add-limit">{t('limits.limit')}</Label>
                <Input
                  id="ca-add-limit"
                  inputMode="numeric"
                  className="w-20"
                  value={addText}
                  placeholder={String(MIN_CHAT_LIMIT)}
                  aria-invalid={addText !== '' && addLimit === null}
                  onChange={(e) => setAddText(e.target.value)}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={
                  !available ||
                  !addPerson ||
                  addLimit === null ||
                  busyRow !== null
                }
                onClick={async () => {
                  if (!addPerson || addLimit === null) return;
                  if (await writeLimit(addPerson, addLimit)) {
                    setAddPerson('');
                    setAddText('');
                  }
                }}
              >
                <Plus />
                {t('limits.add')}
              </Button>
            </div>
          ) : null}
          <p className="text-muted-foreground text-xs">
            {t('limits.range', { min: MIN_CHAT_LIMIT, max: MAX_CHAT_LIMIT })}
          </p>
        </div>
      </section>

      <div className="flex justify-end">
        <Button type="button" onClick={() => void save()} disabled={!canSave}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          {t('save')}
        </Button>
      </div>
    </div>
  );
}
