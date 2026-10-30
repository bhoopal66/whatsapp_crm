'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Info, Loader2, ShieldAlert } from 'lucide-react';

import { useChatPermissions } from '@/hooks/use-chat-permissions';
import { createClient } from '@/lib/supabase/client';
import { setSensitiveGuard, workspaceChatSettings } from '@/lib/chat/api';
import { ChatError } from '@/lib/chat/errors';
import type {
  SensitiveGuard,
  SensitiveMode,
  SensitiveScope,
} from '@/lib/chat/permissions';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';

type Supabase = ReturnType<typeof createClient>;

const MODES: readonly SensitiveMode[] = ['off', 'warn', 'block'];
const SCOPES: readonly SensitiveScope[] = ['guests', 'all'];

/**
 * Settings → Team chat → Sensitive data (migration 158): what happens
 * when a team-chat message's text holds an Emirates ID, a card number
 * or an IBAN. The send RPC enforces it, owners included.
 */
export function SensitiveDataCard({
  supabase,
  accountId,
}: {
  supabase: Supabase;
  accountId: string | null;
}) {
  const t = useTranslations('Settings.teamChat.sensitive');
  const tErrors = useTranslations('Chat.errors');
  const { reload } = useChatPermissions();
  const [saved, setSaved] = useState<SensitiveGuard | null>(null);
  const [draft, setDraft] = useState<SensitiveGuard | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let off = false;
    workspaceChatSettings(supabase, accountId)
      .then((s) => {
        if (off) return;
        setSaved(s.sensitive);
        setDraft(s.sensitive);
      })
      .catch(() => {
        if (!off) setLoadFailed(true);
      });
    return () => {
      off = true;
    };
  }, [supabase, accountId, attempt]);

  const dirty =
    !!saved &&
    !!draft &&
    (saved.mode !== draft.mode || saved.scope !== draft.scope);

  async function save() {
    if (!accountId || !draft || !dirty) return;
    setSaving(true);
    try {
      await setSensitiveGuard(supabase, accountId, draft);
      setSaved(draft);
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

  const option = (
    selected: boolean,
    value: string,
    title: string,
    desc: string
  ) => (
    <label
      key={value}
      className={cn(
        'border-border flex cursor-pointer items-start gap-3 rounded-md border p-3',
        selected && 'border-primary-soft-2 bg-primary-soft',
        saving && 'cursor-not-allowed opacity-60'
      )}
    >
      <RadioGroupItem value={value} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="text-foreground block text-sm font-medium">
          {title}
        </span>
        <span className="text-muted-foreground block text-xs">{desc}</span>
      </span>
    </label>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <ShieldAlert className="text-primary size-4" />
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
        ) : !draft ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> {t('loading')}
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <p
                id="team-chat-sensitive-mode"
                className="text-foreground text-sm font-semibold"
              >
                {t('modeTitle')}
              </p>
              <RadioGroup
                aria-labelledby="team-chat-sensitive-mode"
                value={draft.mode}
                onValueChange={(v) =>
                  setDraft((d) =>
                    d && MODES.includes(v as SensitiveMode)
                      ? { ...d, mode: v as SensitiveMode }
                      : d
                  )
                }
                disabled={saving}
                className="gap-2"
              >
                {MODES.map((m) =>
                  option(
                    draft.mode === m,
                    m,
                    t(`modes.${m}`),
                    t(`modes.${m}Desc`)
                  )
                )}
              </RadioGroup>
            </div>

            <div className="space-y-2">
              <p
                id="team-chat-sensitive-scope"
                className="text-foreground text-sm font-semibold"
              >
                {t('scopeTitle')}
              </p>
              <RadioGroup
                aria-labelledby="team-chat-sensitive-scope"
                value={draft.scope}
                onValueChange={(v) =>
                  setDraft((d) =>
                    d && SCOPES.includes(v as SensitiveScope)
                      ? { ...d, scope: v as SensitiveScope }
                      : d
                  )
                }
                disabled={saving}
                className="gap-2"
              >
                {SCOPES.map((s) =>
                  option(
                    draft.scope === s,
                    s,
                    t(`scopes.${s}`),
                    t(`scopes.${s}Desc`)
                  )
                )}
              </RadioGroup>
              {draft.mode === 'off' && (
                <p className="text-muted-foreground text-xs">
                  {t('scopeWhenOff')}
                </p>
              )}
            </div>

            <div className="border-border bg-muted/40 text-muted-foreground flex gap-2 rounded-lg border p-3 text-sm">
              <Info className="mt-0.5 size-4 shrink-0" />
              <div className="space-y-1">
                <p>{t('detectsNote')}</p>
                <p>{t('ownersNote')}</p>
              </div>
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
