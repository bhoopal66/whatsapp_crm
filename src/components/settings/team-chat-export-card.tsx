'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Download,
  Hash,
  Loader2,
  Lock,
  MessageCircle,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import { exportChannel, listChannels } from '@/lib/chat/api';
import { ChatError } from '@/lib/chat/errors';
import { exportFileName, exportToCsv } from '@/lib/chat/export';
import {
  exportBounds,
  exportRangeError,
  mergeExportChannels,
  type ExportChannelOption,
} from '@/lib/chat/export-range';
import {
  MODERATION_REASON_MAX,
  MODERATION_REASON_MIN,
  moderationReasonValid,
  reasonLength,
} from '@/lib/chat/moderation';
import type { AdminChannelSummary } from '@/lib/chat/admin-tools';
import type { ChannelKind } from '@/lib/chat/types';
import type { AccountMember } from '@/types';
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
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const KIND_ICON: Record<ChannelKind, LucideIcon> = {
  team: Hash,
  private: Lock,
  dm: MessageCircle,
  deal_room: Users,
};

const MAX_EXPORT_MESSAGES = 10_000;

export function TeamChatExportCard({
  supabase,
  people,
}: {
  supabase: ReturnType<typeof createClient>;
  people: AccountMember[];
}) {
  const t = useTranslations('Settings.teamChat.export');
  const tErrors = useTranslations('Chat.errors');
  const { accountId, user } = useAuth();
  const userId = user?.id ?? null;

  const [options, setOptions] = useState<ExportChannelOption[] | null>(null);
  // Each list's failure is cleared when a load settles (and a retry
  // reloads both), so a stale failure never outlives its list.
  const [ownFailed, setOwnFailed] = useState(false);
  const [hiddenFailed, setHiddenFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [reason, setReason] = useState('');
  const [exporting, setExporting] = useState(false);
  const [truncated, setTruncated] = useState(false);

  const names = useMemo(
    () => new Map(people.map((p) => [p.user_id.toLowerCase(), p.full_name])),
    [people]
  );

  useEffect(() => {
    if (!accountId || !userId) return;
    let off = false;
    const own = listChannels(supabase, accountId, userId).then((rows) =>
      rows.map((c): ExportChannelOption => ({
        id: c.id,
        kind: c.kind,
        name: c.name,
        memberNames: c.dmMemberIds
          .map((id) => names.get(id.toLowerCase()))
          .filter((n): n is string => !!n),
      }))
    );
    // Private channels, DMs and deal rooms the admin is not in.
    const hidden = fetch('/api/chat/admin/private-channels').then(
      async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !Array.isArray(json.channels)) throw new Error();
        return (json.channels as AdminChannelSummary[]).map(
          (c): ExportChannelOption => ({
            id: c.id,
            kind: c.kind,
            name: c.name,
            memberNames: c.memberNames,
          })
        );
      }
    );
    // One list failing must not hide the other.
    void Promise.allSettled([own, hidden]).then(([a, b]) => {
      if (off) return;
      setOwnFailed(a.status === 'rejected');
      setHiddenFailed(b.status === 'rejected');
      setOptions(
        mergeExportChannels(
          a.status === 'fulfilled' ? a.value : [],
          b.status === 'fulfilled' ? b.value : []
        )
      );
    });
    return () => {
      off = true;
    };
  }, [supabase, accountId, userId, names, attempt]);

  const label = (c: ExportChannelOption) =>
    c.name ?? (c.memberNames.join(', ') || t('unnamedDm'));
  const needle = filter.trim().toLocaleLowerCase();
  const visible = (options ?? []).filter((c) =>
    label(c).toLocaleLowerCase().includes(needle)
  );
  const selected = options?.find((c) => c.id === selectedId) ?? null;
  const rangeBad = exportRangeError(fromDay, toDay) !== null;
  const ready =
    !!selected && moderationReasonValid(reason) && !rangeBad && !exporting;

  async function run() {
    if (!selected || !ready) return;
    setExporting(true);
    setTruncated(false);
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const bounds = exportBounds({ fromDay, toDay, timeZone });
      const exp = await exportChannel(supabase, {
        channelId: selected.id,
        ...bounds,
        reason: reason.trim(),
      });
      const csv = exportToCsv(exp, { timeZone });
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      // Revoked later: some browsers start the download after click()
      // returns, and a revoked URL would save an empty file.
      const revokeLater = () =>
        setTimeout(() => URL.revokeObjectURL(url), 1500);
      try {
        const a = document.createElement('a');
        a.href = url;
        // exportFileName reads the day off the front, so pass the picked days.
        a.download = exportFileName(
          exp.channel.name ?? label(selected),
          fromDay || null,
          toDay || null
        );
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        revokeLater();
      }
      toast.success(t('done', { count: exp.messages.length }));
      setTruncated(exp.truncated);
      // Every export is audited on its own reason.
      setReason('');
    } catch (err) {
      toast.error(tErrors(err instanceof ChatError ? err.key : 'unknown'));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <Download className="text-primary size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="team-chat-export-filter">{t('channelLabel')}</Label>
          <Input
            id="team-chat-export-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('filterPlaceholder')}
            disabled={!options || options.length === 0}
          />
          <div className="border-border max-h-64 overflow-y-auto rounded-lg border">
            {options === null ? (
              <p className="text-muted-foreground flex items-center gap-2 p-3 text-sm">
                <Loader2 className="size-4 animate-spin" /> {t('loading')}
              </p>
            ) : ownFailed && options.length === 0 ? (
              <p className="text-destructive p-3 text-sm">{t('loadFailed')}</p>
            ) : visible.length === 0 ? (
              <p className="text-muted-foreground p-3 text-sm">
                {options.length === 0 ? t('none') : t('noMatch')}
              </p>
            ) : (
              <ul className="divide-border divide-y">
                {visible.map((c) => {
                  const Icon = KIND_ICON[c.kind];
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        aria-pressed={c.id === selectedId}
                        onClick={() => setSelectedId(c.id)}
                        className={cn(
                          'hover:bg-muted/60 flex w-full items-center gap-3 px-3 py-2 text-start text-sm',
                          c.id === selectedId && 'bg-primary/10'
                        )}
                      >
                        <Icon className="text-muted-foreground size-4 shrink-0" />
                        <span className="min-w-0">
                          <span className="text-foreground block truncate font-medium">
                            {label(c)}
                          </span>
                          <span className="text-muted-foreground block text-xs">
                            {t(`kind.${c.kind}`)}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {options !== null && (ownFailed || hiddenFailed) && (
            <p
              role="alert"
              className="text-destructive flex flex-wrap items-center gap-2 text-xs"
            >
              {ownFailed && options.length > 0
                ? t('loadFailed')
                : hiddenFailed
                  ? t('loadFailedHidden')
                  : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOptions(null);
                  setAttempt((n) => n + 1);
                }}
              >
                {t('retry')}
              </Button>
            </p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="team-chat-export-from">{t('fromLabel')}</Label>
            <Input
              id="team-chat-export-from"
              type="date"
              value={fromDay}
              max={toDay || undefined}
              onChange={(e) => setFromDay(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="team-chat-export-to">{t('toLabel')}</Label>
            <Input
              id="team-chat-export-to"
              type="date"
              value={toDay}
              min={fromDay || undefined}
              onChange={(e) => setToDay(e.target.value)}
            />
          </div>
          <p
            className={cn(
              'text-xs sm:col-span-2',
              rangeBad ? 'text-destructive' : 'text-muted-foreground'
            )}
            role={rangeBad ? 'alert' : undefined}
          >
            {rangeBad ? t('rangeOrder') : t('rangeHint')}
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="team-chat-export-reason">{t('reasonLabel')}</Label>
          <Textarea
            id="team-chat-export-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('reasonPlaceholder')}
            rows={2}
            maxLength={MODERATION_REASON_MAX}
          />
          <p className="text-muted-foreground flex justify-between text-xs">
            <span>{t('reasonHint', { min: MODERATION_REASON_MIN })}</span>
            <span>
              {reasonLength(reason)}/{MODERATION_REASON_MAX}
            </span>
          </p>
        </div>

        <p className="border-warning/30 bg-warning-soft text-warning flex gap-2 rounded-lg border p-3 text-sm">
          {t('auditWarning')}
        </p>

        {truncated && (
          <p
            role="status"
            className="border-warning/30 bg-warning-soft text-warning rounded-lg border p-3 text-sm"
          >
            {t('truncated', { max: MAX_EXPORT_MESSAGES })}
          </p>
        )}

        <Button onClick={() => void run()} disabled={!ready}>
          {exporting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          {t('submit')}
        </Button>
      </CardContent>
    </Card>
  );
}
