'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Clock, Info, Loader2 } from 'lucide-react';

import { useChatPermissions } from '@/hooks/use-chat-permissions';
import { createClient } from '@/lib/supabase/client';
import {
  setWorkspaceChatSettings,
  workspaceChatSettings,
} from '@/lib/chat/api';
import { ChatError } from '@/lib/chat/errors';
import {
  parseWindowMinutes,
  WINDOW_MAX_MINUTES,
  WINDOW_MIN_MINUTES,
  WINDOW_PRESETS,
  windowText,
} from '@/lib/chat/permissions-form';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type Supabase = ReturnType<typeof createClient>;

/** Message keys of WINDOW_PRESETS, in the same order. */
const PRESET_KEYS: Record<(typeof WINDOW_PRESETS)[number], string> = {
  15: 'm15',
  60: 'h1',
  1440: 'h24',
  10080: 'd7',
};

interface Windows {
  edit: number | null;
  delete: number | null;
}

/**
 * Settings → Team chat → Message rules (migration 157): how long after
 * posting a person may edit or delete their own message. Admins are
 * exempt and owners never limited; the RPCs enforce both.
 */
export function MessageRulesCard({
  supabase,
  accountId,
}: {
  supabase: Supabase;
  accountId: string | null;
}) {
  const t = useTranslations('Settings.teamChat.rules');
  const tErrors = useTranslations('Chat.errors');
  const { reload } = useChatPermissions();
  const [saved, setSaved] = useState<Windows | null>(null);
  const [editText, setEditText] = useState('');
  const [deleteText, setDeleteText] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let off = false;
    workspaceChatSettings(supabase, accountId)
      .then((s) => {
        if (off) return;
        setSaved({ edit: s.editWindowMinutes, delete: s.deleteWindowMinutes });
        setEditText(windowText(s.editWindowMinutes));
        setDeleteText(windowText(s.deleteWindowMinutes));
      })
      .catch(() => {
        if (!off) setLoadFailed(true);
      });
    return () => {
      off = true;
    };
  }, [supabase, accountId, attempt]);

  const edit = parseWindowMinutes(editText);
  const del = parseWindowMinutes(deleteText);
  const valid = edit.ok && del.ok;
  const dirty =
    !!saved &&
    valid &&
    (edit.minutes !== saved.edit || del.minutes !== saved.delete);

  async function save() {
    if (!accountId || !edit.ok || !del.ok || !dirty) return;
    const next = { edit: edit.minutes, delete: del.minutes };
    setSaving(true);
    try {
      await setWorkspaceChatSettings(supabase, accountId, {
        editWindowMinutes: next.edit,
        deleteWindowMinutes: next.delete,
      });
      setSaved(next);
      toast.success(t('saved'));
      void reload();
    } catch (err) {
      toast.error(
        err instanceof ChatError && err.key !== 'unknown'
          ? tErrors(err.key)
          : t('saveFailed')
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <Clock className="text-primary size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadFailed ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-destructive text-sm">{t('loadFailed')}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLoadFailed(false);
                setAttempt((n) => n + 1);
              }}
            >
              {t('retry')}
            </Button>
          </div>
        ) : !saved ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> {t('loading')}
          </p>
        ) : (
          <>
            <WindowField
              id="team-chat-edit-window"
              label={t('editLabel')}
              help={t('editHelp')}
              text={editText}
              onText={setEditText}
              disabled={saving}
            />
            <WindowField
              id="team-chat-delete-window"
              label={t('deleteLabel')}
              help={t('deleteHelp')}
              text={deleteText}
              onText={setDeleteText}
              disabled={saving}
            />

            <div className="border-border bg-muted/40 text-muted-foreground flex gap-2 rounded-lg border p-3 text-sm">
              <Info className="mt-0.5 size-4 shrink-0" />
              <p>{t('exemptNote')}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void save()} disabled={!dirty || saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                {t('save')}
              </Button>
              {dirty && (
                <span className="text-muted-foreground text-xs" role="status">
                  {t('unsaved')}
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function WindowField({
  id,
  label,
  help,
  text,
  onText,
  disabled,
}: {
  id: string;
  label: string;
  help: string;
  text: string;
  onText: (text: string) => void;
  disabled: boolean;
}) {
  const t = useTranslations('Settings.teamChat.rules');
  const parsed = parseWindowMinutes(text);
  const current = parsed.ok ? parsed.minutes : undefined;
  const errorId = `${id}-error`;

  const choice = (minutes: number | null, name: string) => (
    <Button
      key={name}
      type="button"
      variant="outline"
      size="sm"
      aria-pressed={current === minutes}
      disabled={disabled}
      onClick={() => onText(windowText(minutes))}
      className={cn(
        current === minutes && 'border-primary bg-primary-soft text-primary'
      )}
    >
      {name}
    </Button>
  );

  return (
    <div className="border-border space-y-2 rounded-lg border p-3">
      <div>
        <Label htmlFor={id} className="text-foreground">
          {label}
        </Label>
        <p className="text-muted-foreground mt-0.5 text-xs">{help}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {choice(null, t('noLimit'))}
        {WINDOW_PRESETS.map((m) => choice(m, t(`presets.${PRESET_KEYS[m]}`)))}
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={text}
          onChange={(e) => onText(e.target.value)}
          inputMode="numeric"
          placeholder={t('noLimit')}
          disabled={disabled}
          aria-invalid={!parsed.ok}
          aria-describedby={parsed.ok ? undefined : errorId}
          className="w-32"
        />
        <span className="text-muted-foreground text-sm">{t('minutes')}</span>
      </div>
      {!parsed.ok && (
        <p id={errorId} className="text-destructive text-xs">
          {t('invalid', { min: WINDOW_MIN_MINUTES, max: WINDOW_MAX_MINUTES })}
        </p>
      )}
    </div>
  );
}
