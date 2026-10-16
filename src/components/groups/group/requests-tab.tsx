'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { reasonKey } from '@/lib/groups/group-page';
import { formatWaId } from '@/lib/groups/ui';

import type { GroupTabProps } from '../group-page';

export interface JoinRequest {
  jid: string;
  waId: string;
  method: string | null;
  requestedAt: number | null;
}

/** GET .../requests; null when the list could not be read. */
export async function fetchJoinRequests(
  groupId: string
): Promise<JoinRequest[] | null> {
  try {
    const res = await fetch(`/api/whatsapp/groups/${groupId}/requests`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { requests?: JoinRequest[] };
    return Array.isArray(json.requests) ? json.requests : [];
  } catch {
    return null;
  }
}

function ago(unixSeconds: number | null, locale: string): string {
  if (!unixSeconds) return '';
  const diff = unixSeconds * 1000 - Date.now();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  return rtf.format(Math.round(diff / 86_400_000), 'day');
}

/** The Requests tab: people asking to join, approve or reject. */
export function RequestsTab({
  groupId,
  detail,
  reload,
  onCount,
}: GroupTabProps & { onCount?: (n: number) => void }) {
  const t = useTranslations('Groups.page');
  const r = useTranslations('Groups.page.requestsTab');
  const locale = useLocale();
  const [rows, setRows] = useState<JoinRequest[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const blocked = detail.blocks.join_requests;

  const load = useCallback(async () => {
    const list = await fetchJoinRequests(groupId);
    setFailed(list === null);
    if (list) {
      setRows(list);
      onCount?.(list.length);
    }
  }, [groupId, onCount]);

  useEffect(() => {
    if (blocked === null) void load();
  }, [blocked, load]);

  if (blocked !== null) {
    return (
      <p className="text-muted-foreground p-2 text-sm">
        {t(`reasons.${reasonKey(blocked)}`)}
      </p>
    );
  }

  const decide = async (row: JoinRequest, action: 'approve' | 'reject') => {
    setBusy(row.jid);
    try {
      const res = await fetch(`/api/whatsapp/groups/${groupId}/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicant: row.jid, action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;
        toast.error(
          body?.code === 'request_failed'
            ? r('failed')
            : t(`reasons.${reasonKey(body?.code)}`)
        );
        return;
      }
      toast.success(action === 'approve' ? r('approved') : r('rejected'));
      const left = (rows ?? []).filter((x) => x.jid !== row.jid);
      setRows(left);
      onCount?.(left.length);
      if (action === 'approve') void reload();
    } catch {
      toast.error(t('reasons.unknown'));
    } finally {
      setBusy(null);
    }
  };

  if (rows === null) {
    return failed ? (
      <div className="flex flex-col items-start gap-2 p-2">
        <p className="text-muted-foreground text-sm">{r('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          {t('retry')}
        </Button>
      </div>
    ) : (
      <div className="bg-muted h-24 animate-pulse rounded-lg" aria-busy />
    );
  }

  if (rows.length === 0) {
    return <p className="text-muted-foreground p-2 text-sm">{r('empty')}</p>;
  }

  return (
    <ul className="divide-border border-border divide-y rounded-lg border">
      {rows.map((row) => (
        <li
          key={row.jid}
          className="flex flex-wrap items-center gap-2 px-3 py-2.5"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {formatWaId(row.waId)}
            </p>
            <p className="text-muted-foreground text-xs">
              {r('requested', { when: ago(row.requestedAt, locale) })}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void decide(row, 'reject')}
            >
              <X className="size-4" />
              {r('reject')}
            </Button>
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void decide(row, 'approve')}
            >
              {busy === row.jid ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              {r('approve')}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
