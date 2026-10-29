'use client';

// Settings → Smart insights (migration 147): one card per Jev-powered
// feature, one Save. Edits stay local until saved; the save is
// version-checked, so a stale screen cannot undo another admin's change.

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Info, Loader2, Sparkles } from 'lucide-react';

import { useChatTags } from '@/hooks/use-chat-tags';
import { useInsightSettings } from '@/hooks/use-insight-settings';
import {
  COMPOSE_CHECK_MODES,
  TAG_AUTO_MIN_P_MAX,
  TAG_AUTO_MIN_P_MIN,
  TAG_SUGGEST_MODES,
  settingsDiffer,
  type InsightSettingsValues,
} from '@/lib/insights/settings-shape';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';

import { ComposeCheckStatsCard } from './compose-check-stats';
import { SettingsPanelHead } from './settings-panel-head';

const NATIVE_FIELD =
  'h-9 rounded-md border border-input bg-card px-2 text-sm text-foreground dark:bg-input/30 disabled:opacity-50';

function valuesOf(v: InsightSettingsValues): InsightSettingsValues {
  return {
    signalsEnabled: v.signalsEnabled,
    tagSuggestMode: v.tagSuggestMode,
    tagAutoMinP: v.tagAutoMinP,
    replyClassEnabled: v.replyClassEnabled,
    replyInterestedTagId: v.replyInterestedTagId,
    composeCheckMode: v.composeCheckMode,
    meaningTriggersEnabled: v.meaningTriggersEnabled,
    kbGapJudgeEnabled: v.kbGapJudgeEnabled,
  };
}

export function InsightsPanel() {
  const t = useTranslations('Insights.settings');
  const { settings, available, canEdit, loading, reload } =
    useInsightSettings();
  const { tags } = useChatTags();
  const mainTags = useMemo(
    () => (tags ?? []).filter((tag) => !tag.parent_id),
    [tags]
  );

  const saved = useMemo(() => valuesOf(settings), [settings]);
  const [draft, setDraft] = useState<InsightSettingsValues>(saved);
  const [saving, setSaving] = useState(false);
  // A fresh load (or another screen's reload) replaces the draft.
  const [draftOf, setDraftOf] = useState(saved);
  if (draftOf !== saved) {
    setDraftOf(saved);
    setDraft(saved);
  }

  const dirty = settingsDiffer(draft, saved);
  const disabled = loading || saving || !canEdit || !available;
  const set = <K extends keyof InsightSettingsValues>(
    key: K,
    value: InsightSettingsValues[K]
  ) => setDraft((d) => ({ ...d, [key]: value }));

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/insights/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draft,
          expectedUpdatedAt: settings.updatedAt,
        }),
      });
      if (res.status === 409) {
        toast.error(t('conflict'), {
          action: { label: t('reload'), onClick: () => void reload() },
        });
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(body?.error ?? t('saveFailed'));
        return;
      }
      toast.success(t('saved'));
      await reload();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <Button onClick={() => void save()} disabled={disabled || !dirty}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t('save')}
          </Button>
        }
      />

      {!loading && !available && (
        <div
          role="status"
          className="border-warning/30 bg-warning-soft text-foreground flex items-start gap-2 rounded-lg border p-3 text-sm"
        >
          <Info className="text-warning mt-0.5 size-4 shrink-0" />
          <span>{t('unavailable')}</span>
        </div>
      )}

      <FeatureCard
        id="insights-signals"
        title={t('signals.title')}
        description={t('signals.description')}
        control={
          <Switch
            checked={draft.signalsEnabled}
            onCheckedChange={(v) => set('signalsEnabled', v)}
            disabled={disabled}
            aria-labelledby="insights-signals-label"
          />
        }
      />

      <FeatureCard
        id="insights-tags"
        title={t('tags.title')}
        description={t('tags.description')}
        control={
          <select
            className={NATIVE_FIELD}
            value={draft.tagSuggestMode}
            onChange={(e) =>
              set(
                'tagSuggestMode',
                e.target.value as InsightSettingsValues['tagSuggestMode']
              )
            }
            disabled={disabled}
            aria-labelledby="insights-tags-label"
          >
            {TAG_SUGGEST_MODES.map((m) => (
              <option key={m} value={m}>
                {t(`tags.mode.${m}`)}
              </option>
            ))}
          </select>
        }
      >
        {draft.tagSuggestMode === 'auto' && (
          <div className="bg-card-2 space-y-2 rounded-md p-3">
            <label
              htmlFor="insights-tag-min-p"
              className="text-foreground text-sm font-medium"
            >
              {t('tags.minP', { percent: Math.round(draft.tagAutoMinP * 100) })}
            </label>
            <input
              id="insights-tag-min-p"
              type="range"
              min={Math.round(TAG_AUTO_MIN_P_MIN * 100)}
              max={Math.round(TAG_AUTO_MIN_P_MAX * 100)}
              step={1}
              value={Math.round(draft.tagAutoMinP * 100)}
              onChange={(e) => set('tagAutoMinP', Number(e.target.value) / 100)}
              disabled={disabled}
              className="accent-primary w-full"
            />
            <p className="text-muted-foreground text-xs">
              {t('tags.autoNote')}
            </p>
          </div>
        )}
      </FeatureCard>

      <FeatureCard
        id="insights-replies"
        title={t('replies.title')}
        description={t('replies.description')}
        control={
          <Switch
            checked={draft.replyClassEnabled}
            onCheckedChange={(v) => set('replyClassEnabled', v)}
            disabled={disabled}
            aria-labelledby="insights-replies-label"
          />
        }
      >
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
          <label
            htmlFor="insights-reply-tag"
            className="text-foreground text-sm"
          >
            {t('replies.tagLabel')}
          </label>
          <select
            id="insights-reply-tag"
            className={NATIVE_FIELD}
            value={draft.replyInterestedTagId ?? ''}
            onChange={(e) =>
              set('replyInterestedTagId', e.target.value || null)
            }
            disabled={disabled}
          >
            <option value="">{t('replies.none')}</option>
            {mainTags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        </div>
      </FeatureCard>

      <FeatureCard
        id="insights-compose"
        title={t('compose.title')}
        description={t('compose.description')}
        control={
          <select
            className={NATIVE_FIELD}
            value={draft.composeCheckMode}
            onChange={(e) =>
              set(
                'composeCheckMode',
                e.target.value as InsightSettingsValues['composeCheckMode']
              )
            }
            disabled={disabled}
            aria-labelledby="insights-compose-label"
          >
            {COMPOSE_CHECK_MODES.map((m) => (
              <option key={m} value={m}>
                {t(`compose.mode.${m}`)}
              </option>
            ))}
          </select>
        }
      />

      {canEdit && <ComposeCheckStatsCard />}

      <FeatureCard
        id="insights-meaning"
        title={t('meaning.title')}
        description={t('meaning.description')}
        control={
          <Switch
            checked={draft.meaningTriggersEnabled}
            onCheckedChange={(v) => set('meaningTriggersEnabled', v)}
            disabled={disabled}
            aria-labelledby="insights-meaning-label"
          />
        }
      />

      <FeatureCard
        id="insights-kbgap"
        title={t('kbGap.title')}
        description={t('kbGap.description')}
        control={
          <Switch
            checked={draft.kbGapJudgeEnabled}
            onCheckedChange={(v) => set('kbGapJudgeEnabled', v)}
            disabled={disabled}
            aria-labelledby="insights-kbgap-label"
          />
        }
      />
    </div>
  );
}

function FeatureCard({
  id,
  title,
  description,
  control,
  children,
}: {
  id: string;
  title: string;
  description: string;
  control: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-foreground flex items-center gap-2">
            <Sparkles className="text-primary size-4" />
            <span id={`${id}-label`}>{title}</span>
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {description}
          </CardDescription>
        </div>
        <div className="shrink-0">{control}</div>
      </CardHeader>
      {children ? <CardContent>{children}</CardContent> : null}
    </Card>
  );
}
