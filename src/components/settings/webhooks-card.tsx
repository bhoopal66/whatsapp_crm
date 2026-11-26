'use client';

// ============================================================
// WebhooksCard — Settings → API keys, under the key list.
//
// Webhook endpoints are made through /api/v1/webhooks; here an owner or
// admin sees which receivers get the workspace's events, and can switch
// one off or delete it (315). Switching on needs a live key.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Power, Trash2 } from 'lucide-react';

import { ErrorState } from '@/components/dashboard/error-state';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { DEFAULT_TIME_ZONE } from '@/lib/pbx/call-status';
import type { AccountWebhook } from '@/lib/webhooks/account-list';

export type WebhooksState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; webhooks: AccountWebhook[] };

async function readWebhooks(): Promise<WebhooksState> {
  try {
    const res = await fetch('/api/account/webhooks', { cache: 'no-store' });
    const data = (await res.json()) as { webhooks?: AccountWebhook[] };
    if (res.ok && Array.isArray(data.webhooks)) {
      return { status: 'ready', webhooks: data.webhooks };
    }
  } catch (err) {
    console.error('[WebhooksCard] load error:', err);
  }
  return { status: 'error' };
}

/** The list, held by the screen: the revoke question counts in it too. */
export function useWebhooks() {
  const [state, setState] = useState<WebhooksState>({ status: 'loading' });
  // Only the newest read counts: one begun before a revoke must not put
  // the old list back.
  const newest = useRef(0);

  /** Read again; what is shown stays until the answer. */
  const reload = useCallback(() => {
    const read = ++newest.current;
    return readWebhooks().then((next) => {
      if (read === newest.current) setState(next);
    });
  }, []);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    void reload();
  }, [reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { state, reload, retry };
}

type Action = 'off' | 'delete';

export function WebhooksCard({
  state,
  reload,
  retry,
}: {
  state: WebhooksState;
  reload: () => Promise<void>;
  retry: () => void;
}) {
  const t = useTranslations('Settings.apiKeys');
  const format = useFormatter();
  const [asking, setAsking] = useState<{
    action: Action;
    webhook: AccountWebhook;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const when = (iso: string) =>
    format.dateTime(new Date(iso), {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: DEFAULT_TIME_ZONE,
    });
  const hostOf = (w: AccountWebhook) => w.host ?? t('webhookUnknownHost');

  async function run(action: Action, webhook: AccountWebhook) {
    setBusy(webhook.id);
    const off = action === 'off';
    try {
      const res = await fetch(
        `/api/account/webhooks/${webhook.id}`,
        off
          ? {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ is_active: false }),
            }
          : { method: 'DELETE' }
      );
      if (res.ok) {
        toast.success(
          t(off ? 'webhookOffSuccess' : 'webhookDeleteSuccess', {
            host: hostOf(webhook),
          })
        );
      } else {
        toast.error(t(off ? 'webhookOffFailed' : 'webhookDeleteFailed'));
      }
    } catch (err) {
      console.error('[WebhooksCard] change error:', err);
      toast.error(t('networkError'));
    }
    // Also after a failure: an unanswered change may have happened, and a
    // 404 means the row is gone.
    await reload();
    setBusy(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('webhooksTitle')}</CardTitle>
        <CardDescription>{t('webhooksDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        {state.status === 'loading' && (
          <div role="status" className="flex justify-center py-8">
            <Loader2 className="text-primary size-5 animate-spin" />
            <span className="sr-only">{t('webhooksLoading')}</span>
          </div>
        )}

        {state.status === 'error' && (
          <ErrorState message={t('webhooksLoadFailed')} onRetry={retry} />
        )}

        {state.status === 'ready' && state.webhooks.length === 0 && (
          <p className="text-muted-foreground py-6 text-center text-sm">
            {t('noWebhooks')}
          </p>
        )}

        {state.status === 'ready' && state.webhooks.length > 0 && (
          <ul className="divide-border divide-y">
            {state.webhooks.map((w) => (
              <li
                key={w.id}
                className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      dir={w.host ? 'ltr' : undefined}
                      className="text-foreground min-w-0 text-sm font-medium break-all"
                    >
                      {hostOf(w)}
                    </span>
                    <Badge
                      className={
                        w.is_active
                          ? 'bg-success-soft text-success'
                          : 'bg-muted text-muted-foreground'
                      }
                    >
                      {t(w.is_active ? 'webhookOn' : 'webhookOff')}
                    </Badge>
                  </div>

                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {w.events.map((event) => (
                      <Badge
                        key={event}
                        dir="ltr"
                        className="border-border bg-muted text-muted-foreground text-xs"
                      >
                        {event}
                      </Badge>
                    ))}
                  </div>

                  <p className="text-muted-foreground mt-1.5 text-xs break-words">
                    {w.key
                      ? t('webhookKey', { name: w.key.name })
                      : t('webhookNoKey')}
                    {w.key && w.key.status !== 'active'
                      ? ` (${t(w.key.status)})`
                      : ''}
                  </p>
                  {w.first_failure_at && (
                    <p className="text-destructive mt-1 text-xs">
                      {t('webhookFailing', {
                        date: when(w.first_failure_at),
                        count: w.failure_count,
                      })}
                    </p>
                  )}
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t('created', { date: when(w.created_at) })}
                    {' · '}
                    {w.last_delivery_at
                      ? t('webhookLastDelivery', {
                          date: when(w.last_delivery_at),
                        })
                      : t('webhookNeverDelivered')}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  {w.is_active && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => setAsking({ action: 'off', webhook: w })}
                    >
                      {busy === w.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Power className="size-4" />
                      )}
                      {t('webhookSwitchOff')}
                    </Button>
                  )}
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => setAsking({ action: 'delete', webhook: w })}
                  >
                    <Trash2 className="size-4" />
                    {t('webhookDelete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        title={t(
          asking?.action === 'delete' ? 'webhookDeleteTitle' : 'webhookOffTitle'
        )}
        description={t(
          asking?.action === 'delete' ? 'webhookDeleteBody' : 'webhookOffBody',
          {
            host: asking ? hostOf(asking.webhook) : '',
            events: asking?.webhook.events.join(', ') ?? '',
          }
        )}
        cancelLabel={t('cancel')}
        confirmLabel={t(
          asking?.action === 'delete' ? 'webhookDelete' : 'webhookSwitchOff'
        )}
        destructive
        onConfirm={() => {
          if (!asking) return;
          setAsking(null);
          void run(asking.action, asking.webhook);
        }}
      />
    </Card>
  );
}
