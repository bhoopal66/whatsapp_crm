'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  CircleAlert,
  CircleCheck,
  Info,
  Loader2,
  TriangleAlert,
} from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  draftBody,
  draftFrom,
  isDirty,
  parseSettingsView,
  saveErrorText,
  statusLines,
  type DealRoomSettingsView,
  type SettingsDraft,
  type TemplateLine,
} from '@/lib/deal-rooms/settings-ui';
import { cn } from '@/lib/utils';

import { SettingsPanelHead } from './settings-panel-head';

const OK = 'text-emerald-700 [[data-mode=dark]_&]:text-emerald-300';
const WAIT = 'text-amber-700 [[data-mode=dark]_&]:text-amber-300';

/**
 * Settings → Deal rooms (module 014c, admin+): the group-invite template
 * each person is sent in their own 1:1 chat, and whether Meta has it
 * approved. `/api/deal-rooms/settings` judges every value; the rules for
 * what to show and send live in `lib/deal-rooms/settings-ui`.
 */
export function DealRoomsPanel({
  onOpenConsent,
}: {
  onOpenConsent?: () => void;
}) {
  const t = useTranslations('Settings.dealRooms');
  const tSections = useTranslations('Settings.sections');
  const [view, setView] = useState<DealRoomSettingsView | null>(null);
  const [draft, setDraft] = useState<SettingsDraft>(() => ({
    name: '',
    language: '',
    nameAr: '',
  }));
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let off = false;
    fetch('/api/deal-rooms/settings', { cache: 'no-store' })
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        const next = res.ok ? parseSettingsView(json) : null;
        if (!next) throw new Error();
        if (off) return;
        setView(next);
        setDraft(draftFrom(next.settings));
      })
      .catch(() => {
        if (!off) setLoadFailed(true);
      });
    return () => {
      off = true;
    };
  }, []);

  const canSave = !!view && !saving && isDirty(draft, view.settings);
  const lines = view ? statusLines(view, draft) : { main: null, ar: null };

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/deal-rooms/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftBody(draft)),
      });
      const json = await res.json().catch(() => null);
      const next = res.ok ? parseSettingsView(json) : null;
      if (!next) {
        toast.error(
          t('saveFailed', { error: saveErrorText(json, res.status) })
        );
        return;
      }
      // The answer is what was stored (names trimmed), with fresh statuses.
      setView(next);
      setDraft(draftFrom(next.settings));
      toast.success(t('saved'));
    } catch (err) {
      toast.error(
        t('saveFailed', {
          error: err instanceof Error ? err.message : String(err),
        })
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="animate-in fade-in-50 max-w-3xl space-y-6 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {view && !view.metaNumber ? (
        <Alert className="border-amber-300 bg-amber-50 text-amber-900 [[data-mode=dark]_&]:border-amber-500/40 [[data-mode=dark]_&]:bg-amber-500/10 [[data-mode=dark]_&]:text-amber-200">
          <TriangleAlert />
          <AlertDescription className="text-amber-900 [[data-mode=dark]_&]:text-amber-200">
            {t('noMeta')}
          </AlertDescription>
        </Alert>
      ) : null}

      {loadFailed ? (
        <p className="text-destructive text-sm" role="alert">
          {t('loadFailed')}
        </p>
      ) : !view ? (
        <div
          className="bg-muted/50 h-40 w-full animate-pulse rounded-xl"
          aria-busy="true"
        />
      ) : (
        <Card>
          <CardContent>
            <form
              className="space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                if (canSave) void save();
              }}
            >
              <p className="text-muted-foreground text-sm">{t('help')}</p>

              <div className="grid gap-2 sm:max-w-md">
                <Label htmlFor="deal-room-invite-name">{t('name')}</Label>
                <Input
                  id="deal-room-invite-name"
                  value={draft.name}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, name: e.target.value }))
                  }
                  disabled={saving}
                  maxLength={512}
                  autoComplete="off"
                  spellCheck={false}
                  dir="ltr"
                  aria-describedby={
                    lines.main ? 'deal-room-invite-name-status' : undefined
                  }
                />
                {lines.main ? (
                  <StatusLine
                    id="deal-room-invite-name-status"
                    line={lines.main}
                  />
                ) : null}
              </div>

              <div className="grid gap-2 sm:max-w-40">
                <Label htmlFor="deal-room-invite-language">
                  {t('language')}
                </Label>
                <Input
                  id="deal-room-invite-language"
                  value={draft.language}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, language: e.target.value }))
                  }
                  disabled={saving}
                  maxLength={8}
                  autoComplete="off"
                  spellCheck={false}
                  dir="ltr"
                />
              </div>

              <div className="grid gap-2 sm:max-w-md">
                <Label htmlFor="deal-room-invite-name-ar">{t('nameAr')}</Label>
                <Input
                  id="deal-room-invite-name-ar"
                  value={draft.nameAr}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, nameAr: e.target.value }))
                  }
                  disabled={saving}
                  maxLength={512}
                  autoComplete="off"
                  spellCheck={false}
                  dir="ltr"
                  aria-describedby={
                    lines.ar ? 'deal-room-invite-name-ar-status' : undefined
                  }
                />
                <p className="text-muted-foreground text-xs">{t('arHelp')}</p>
                {lines.ar ? (
                  <StatusLine
                    id="deal-room-invite-name-ar-status"
                    line={lines.ar}
                  />
                ) : null}
              </div>

              <Button type="submit" disabled={!canSave}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {t('save')}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="border-border bg-muted/40 text-muted-foreground flex gap-2 rounded-xl border p-4 text-sm">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p>
          {t('banks')}{' '}
          {onOpenConsent ? (
            <Button
              variant="link"
              size="sm"
              className="h-auto px-0 text-sm"
              onClick={onOpenConsent}
            >
              {tSections('consent-retention')}
            </Button>
          ) : null}
        </p>
      </div>
    </section>
  );
}

function StatusLine({ id, line }: { id: string; line: TemplateLine }) {
  const t = useTranslations('Settings.dealRooms');
  const Icon = line.tone === 'ok' ? CircleCheck : CircleAlert;
  return (
    <p
      id={id}
      className={cn(
        'flex items-start gap-1.5 text-xs',
        line.tone === 'ok' ? OK : WAIT
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>
        {line.kind === 'notReady'
          ? t('notReady', { status: line.status })
          : t(line.kind)}
      </span>
    </p>
  );
}
