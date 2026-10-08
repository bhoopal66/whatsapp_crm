'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  estimateAudience,
  resolveSendTime,
  type AudienceConfig,
} from '@/hooks/use-broadcast-sending';
import { parseQuietHours, type QuietHours } from '@/lib/broadcasts/quiet-hours';
import { cachedQuery, REFERENCE_CACHE_TTL_MS } from '@/lib/client-cache';
import { useAuth } from '@/hooks/use-auth';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  Send,
  Loader2,
  Users,
  Save,
  CalendarClock,
  MoonStar,
  Workflow,
  Bot,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * Local-time value of a `<input type="datetime-local">` for a Date,
 * i.e. "YYYY-MM-DDTHH:MM" in the browser's zone.
 */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Sentinel for "no follow-up flow" — the Select needs a non-empty value. */
const NO_FLOW = '__none__';

interface FlowOption {
  id: string;
  name: string;
  trigger_type: string;
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  /** Null = send now from this tab; a Date = schedule for the cron. */
  scheduledAt: Date | null;
  onScheduledAtChange: (at: Date | null) => void;
  quietHours: QuietHours | null;
  onQuietHoursChange: (q: QuietHours | null) => void;
  /**
   * Flow started for each recipient on their first reply to this
   * campaign (migration 054). Null = replies go to automations / the AI
   * agent as before.
   */
  followUpFlowId: string | null;
  onFollowUpFlowIdChange: (id: string | null) => void;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  scheduledAt,
  onScheduledAtChange,
  quietHours,
  onQuietHoursChange,
  followUpFlowId,
  onFollowUpFlowIdChange,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);
  const { accountId } = useAuth();

  // Active flows the campaign can hand its replies to, and whether the
  // AI agent is switched on (it is what catches off-script replies and
  // anything after the flow). Both are slow-moving reference data —
  // cached like the tag and member lists are.
  const [flows, setFlows] = useState<FlowOption[]>([]);
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [flowRows, ai] = await Promise.all([
        cachedQuery('flows:active', REFERENCE_CACHE_TTL_MS, async () => {
          const { data } = await supabase
            .from('flows')
            .select('id, name, trigger_type')
            .eq('status', 'active')
            .order('name');
          return (data ?? []) as FlowOption[];
        }),
        cachedQuery(
          'ai:auto-reply-enabled',
          REFERENCE_CACHE_TTL_MS,
          async () => {
            const { data } = await supabase
              .from('ai_configs')
              .select('auto_reply_enabled, is_active')
              .limit(1)
              .maybeSingle();
            return Boolean(data?.is_active && data?.auto_reply_enabled);
          }
        ),
      ]);
      if (cancelled) return;
      setFlows(flowRows);
      setAiEnabled(ai);
    })().catch((err) => console.error('Failed to load flow options:', err));
    return () => {
      cancelled = true;
    };
  }, []);

  // Quiet-hours editing state. The window is only handed up when it
  // parses, so the parent never holds a half-typed value.
  const [quietStart, setQuietStart] = useState(quietHours?.start ?? '21:00');
  const [quietEnd, setQuietEnd] = useState(quietHours?.end ?? '08:00');
  const [quietTz] = useState(quietHours?.tz ?? browserTimeZone());
  const quietEnabled = quietHours !== null;

  const setQuiet = (enabled: boolean, start = quietStart, end = quietEnd) => {
    onQuietHoursChange(
      enabled ? parseQuietHours({ start, end, tz: quietTz }) : null
    );
  };

  // What will actually happen on confirm: now, the chosen time, or the
  // chosen/now time pushed past the quiet window. Recomputed per render
  // so the dialog and the button label always agree with the hook.
  const effectiveSendAt = useMemo(
    () => resolveSendTime(new Date(), scheduledAt, quietHours),
    [scheduledAt, quietHours]
  );
  const isSchedule = effectiveSendAt !== null;

  // The step-2 count (`estimateAudience`): exclusions and opted-out
  // customers already taken off, so the confirm states who is sent to.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadingReach(true);
      try {
        const estimate = await estimateAudience(
          createClient(),
          accountId,
          audience
        );
        if (!cancelled) setEstimatedReach(estimate?.recipients ?? 0);
      } catch (err) {
        console.error('[broadcast] audience estimate failed:', err);
        if (!cancelled) setEstimatedReach(0);
      } finally {
        if (!cancelled) setLoadingReach(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [audience, accountId]);

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'chat_tags'
        ? t('scheduleSend.audienceChatTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : audience.type === 'compass'
            ? t('scheduleSend.audienceCompass')
            : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-foreground text-lg font-semibold">
          {t('scheduleSend.title')}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="text-foreground mb-1.5 block text-sm font-medium">
          {t('scheduleSend.broadcastName')}
        </label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="border-border bg-card/50 space-y-3 rounded-xl border p-4">
        <p className="text-foreground text-sm font-medium">
          {t('scheduleSend.summary')}
        </p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">
              {t('scheduleSend.template')}
            </p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">
              {t('scheduleSend.audience')}
            </p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Estimated Reach</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="text-primary h-3 w-3 animate-spin" />
              ) : (
                <>
                  <Users className="text-primary h-3.5 w-3.5" />
                  <p className="text-foreground font-medium">
                    {estimatedReach.toLocaleString()}
                  </p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Language</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {/* When to send */}
      <div className="border-border bg-card/50 space-y-4 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <CalendarClock className="text-primary h-4 w-4" />
          <p className="text-foreground text-sm font-medium">
            {t('scheduleSend.whenTitle')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={scheduledAt ? 'outline' : 'default'}
            onClick={() => onScheduledAtChange(null)}
            disabled={isProcessing}
          >
            {t('scheduleSend.whenNow')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={scheduledAt ? 'default' : 'outline'}
            onClick={() =>
              onScheduledAtChange(
                scheduledAt ?? new Date(Date.now() + 60 * 60 * 1000)
              )
            }
            disabled={isProcessing}
          >
            {t('scheduleSend.whenLater')}
          </Button>
          {scheduledAt && (
            <Input
              type="datetime-local"
              value={toLocalInputValue(scheduledAt)}
              min={toLocalInputValue(new Date())}
              onChange={(e) => {
                const d = new Date(e.target.value);
                if (!Number.isNaN(d.getTime())) onScheduledAtChange(d);
              }}
              disabled={isProcessing}
              className="border-border bg-muted text-foreground w-auto"
            />
          )}
        </div>
        {scheduledAt && (
          <p className="text-muted-foreground text-xs">
            {t('scheduleSend.whenLaterHint')}
          </p>
        )}

        <div className="border-border border-t pt-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-start gap-2">
              <MoonStar className="text-primary mt-0.5 h-4 w-4" />
              <div>
                <p className="text-foreground text-sm font-medium">
                  {t('scheduleSend.quietTitle')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('scheduleSend.quietDesc', { tz: quietTz })}
                </p>
              </div>
            </div>
            <Switch
              checked={quietEnabled}
              onCheckedChange={(v) => setQuiet(v)}
              disabled={isProcessing}
            />
          </div>
          {quietEnabled && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">
                {t('scheduleSend.quietFrom')}
              </span>
              <Input
                type="time"
                value={quietStart}
                onChange={(e) => {
                  setQuietStart(e.target.value);
                  setQuiet(true, e.target.value, quietEnd);
                }}
                disabled={isProcessing}
                className="border-border bg-muted text-foreground w-auto"
              />
              <span className="text-muted-foreground">
                {t('scheduleSend.quietTo')}
              </span>
              <Input
                type="time"
                value={quietEnd}
                onChange={(e) => {
                  setQuietEnd(e.target.value);
                  setQuiet(true, quietStart, e.target.value);
                }}
                disabled={isProcessing}
                className="border-border bg-muted text-foreground w-auto"
              />
            </div>
          )}
        </div>

        {isSchedule && (
          <p className="border-primary/20 bg-primary/5 text-foreground rounded-md border px-3 py-2 text-xs">
            {t('scheduleSend.willSendAt', {
              when: effectiveSendAt.toLocaleString(),
            })}
          </p>
        )}
      </div>

      {/* What happens when they reply */}
      <div className="border-border bg-card/50 space-y-3 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <Workflow className="text-primary h-4 w-4" />
          <p className="text-foreground text-sm font-medium">
            {t('scheduleSend.followUpTitle')}
          </p>
        </div>
        {/* t.raw(): the copy quotes the {{vars.…}} placeholders, which
            are not valid ICU (see icu-safety.test.ts). */}
        <p className="text-muted-foreground text-xs">
          {t.raw('scheduleSend.followUpDesc')}
        </p>
        <Select
          value={followUpFlowId ?? NO_FLOW}
          onValueChange={(v) =>
            onFollowUpFlowIdChange(v === NO_FLOW ? null : v)
          }
          disabled={isProcessing}
        >
          <SelectTrigger className="border-border bg-muted text-foreground w-full sm:max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_FLOW}>
              {t('scheduleSend.followUpNone')}
            </SelectItem>
            {flows.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {flows.length === 0 && (
          <p className="text-muted-foreground text-xs">
            {t('scheduleSend.followUpNoFlows')}
          </p>
        )}
        <div className="border-border flex items-start gap-2 border-t pt-3">
          <Bot className="text-primary mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-muted-foreground text-xs">
            {aiEnabled === false
              ? t('scheduleSend.followUpAiOff')
              : t('scheduleSend.followUpAiOn')}
          </p>
        </div>
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="border-primary/20 bg-primary/5 rounded-xl border p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="text-primary h-4 w-4 animate-spin" />
              <p className="text-foreground text-sm font-medium">
                {t('scheduleSend.sending')}
              </p>
            </div>
            <span className="text-primary text-xs font-medium">
              {progress}%
            </span>
          </div>
          <div className="bg-muted h-1.5 w-full rounded-full">
            <div
              className="bg-primary h-1.5 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
            <DialogTrigger
              render={
                <Button
                  disabled={!name.trim() || isProcessing}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                />
              }
            >
              {isSchedule ? (
                <CalendarClock className="h-4 w-4" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {isSchedule
                ? t('scheduleSend.scheduleButton')
                : t('scheduleSend.sendNow')}
            </DialogTrigger>
            <DialogContent className="border-border bg-popover sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">
                  {isSchedule
                    ? t('scheduleSend.confirmScheduleTitle')
                    : t('scheduleSend.confirmTitle')}
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  {isSchedule
                    ? t('scheduleSend.confirmScheduleBody', {
                        count: estimatedReach.toLocaleString(),
                        template: template.name,
                        when: effectiveSendAt.toLocaleString(),
                      })
                    : t('scheduleSend.confirmBody', {
                        count: estimatedReach.toLocaleString(),
                        template: template.name,
                      })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowConfirm(false)}
                  className="border-border text-muted-foreground"
                >
                  {t('cancel')}
                </Button>
                <Button
                  onClick={() => {
                    setShowConfirm(false);
                    onSend();
                  }}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {isSchedule ? (
                    <CalendarClock className="h-4 w-4" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  {isSchedule
                    ? t('scheduleSend.scheduleButton')
                    : t('scheduleSend.sendNow')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
