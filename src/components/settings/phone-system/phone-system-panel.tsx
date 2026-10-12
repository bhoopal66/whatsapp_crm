'use client';

// Settings → Phone system: the Yeastar P-Series connection, its numbers
// and extensions, and the recording rules (docs/yeastar.md). Admin+,
// like every /api/pbx route it calls.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, PlugZap } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import {
  PBX_AUTH_BACKOFF_MINUTES,
  baseUrlHost,
  connectionState,
  lastEventAgo,
  routedWorkspaceNames,
  type PbxConnectionView,
} from '@/lib/pbx/admin-ui';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { SettingsPanelHead } from '../settings-panel-head';
import { ConnectionDialog } from './connection-dialog';
import { DOT, pbxFetch, type PbxResult } from './fetch';
import {
  ExtensionsCard,
  RecordingRulesCard,
  RoutesCard,
  type RouteView,
} from './phone-system-lists';

export function PhoneSystemPanel() {
  const t = useTranslations('Settings.phoneSystem');
  const { workspaces } = useAuth();
  const [conn, setConn] = useState<PbxConnectionView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [routes, setRoutes] = useState<RouteView[]>([]);
  const [editing, setEditing] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [testing, setTesting] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const apply = useCallback(
    (res: PbxResult<{ connection: PbxConnectionView | null }>) => {
      if (res.ok) setConn(res.data.connection);
      else
        toast.error(t('loadFailed'), { description: res.error ?? undefined });
      setLoaded(true);
      setNow(new Date());
    },
    [t]
  );
  const loadConnection = useCallback(
    async () => apply(await pbxFetch('/api/pbx/connection')),
    [apply]
  );

  useEffect(() => {
    let live = true;
    void pbxFetch<{ connection: PbxConnectionView | null }>(
      '/api/pbx/connection'
    ).then((res) => {
      if (live) apply(res);
    });
    // "last event 2 s ago" stays roughly true while the page is open.
    const tick = setInterval(() => setNow(new Date()), 15_000);
    return () => {
      live = false;
      clearInterval(tick);
    };
  }, [apply]);

  const shared = useMemo(
    () => routedWorkspaceNames(routes, workspaces),
    [routes, workspaces]
  );

  const test = async () => {
    setTesting(true);
    const res = await pbxFetch<{ status: string; extensionCount?: number }>(
      '/api/pbx/connection/test',
      { method: 'POST' }
    );
    setTesting(false);
    if (res.ok) {
      if (res.data.status === 'connected')
        toast.success(
          t('test.connected', { count: res.data.extensionCount ?? 0 })
        );
      else
        toast.error(
          t(
            res.data.status === 'auth_failed'
              ? 'test.authFailed'
              : 'test.disconnected'
          )
        );
    } else if (res.status === 429) {
      toast.error(t('test.backoff', { minutes: PBX_AUTH_BACKOFF_MINUTES }));
    } else {
      toast.error(t(res.status === 404 ? 'test.noConnection' : 'test.failed'), {
        description: res.error ?? undefined,
      });
    }
    await loadConnection();
  };

  const { state, tone } = connectionState(conn);
  const ago = lastEventAgo(conn?.lastEventAt ?? null, now);
  const agoText = ago
    ? t('connection.lastEvent', ago)
    : t('connection.noEvents');

  return (
    <div className="min-w-0 space-y-6">
      <SettingsPanelHead
        title={t('title')}
        description={
          shared.length
            ? t('subtitleShared', { names: shared.join(', ') })
            : t('subtitle')
        }
        action={
          <Button variant="outline" onClick={test} disabled={testing || !conn}>
            {testing ? <Loader2 className="animate-spin" /> : <PlugZap />}
            {t('testConnection')}
          </Button>
        }
      />

      {!loaded ? (
        <div className="bg-muted/50 h-32 animate-pulse rounded-xl" />
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          <StatusCard title={t('connection.title')}>
            <p className="flex items-center gap-2 font-medium">
              <span className={cn('size-2 shrink-0 rounded-full', DOT[tone])} />
              {state === 'connected'
                ? `${t('connection.connected')} · ${agoText}`
                : t(
                    state === 'auth_failed'
                      ? 'connection.authFailed'
                      : state === 'none'
                        ? 'connection.none'
                        : 'connection.notConnected'
                  )}
            </p>
            {conn ? (
              <>
                <p className="text-muted-foreground break-all">
                  {baseUrlHost(conn.baseUrl)}
                  {conn.firmware
                    ? ` · ${t('connection.firmware', { version: conn.firmware })}`
                    : ''}
                </p>
                <p className="text-muted-foreground">
                  {t('connection.clientId', {
                    last4: conn.clientIdLast4 ?? '',
                  })}
                </p>
                {conn.lastError && state !== 'connected' ? (
                  <p className="text-destructive break-words">
                    {conn.lastError}
                  </p>
                ) : null}
              </>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className="mt-1 self-start"
              onClick={() => {
                setFormKey((k) => k + 1);
                setEditing(true);
              }}
            >
              {conn ? t('connection.edit') : t('connection.setUp')}
            </Button>
          </StatusCard>

          <StatusCard title={t('events.title')}>
            <p>{t('events.liveLink', { ago: agoText })}</p>
            <p className="text-muted-foreground">{t('events.sharedToken')}</p>
          </StatusCard>

          <StatusCard title={t('softphone.title')}>
            <p className="flex items-center gap-2 font-medium">
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  DOT[conn?.hasSdkCredentials ? 'green' : 'muted']
                )}
              />
              {t(
                conn?.hasSdkCredentials
                  ? 'softphone.enabled'
                  : 'softphone.notConfigured'
              )}
            </p>
            <p className="text-muted-foreground">
              {t('softphone.usage', {
                used: conn?.softphoneUsers ?? 0,
                mapped: conn?.mappedExtensions ?? 0,
              })}
            </p>
          </StatusCard>
        </div>
      )}

      <RoutesCard connected={!!conn} onRoutes={setRoutes} />
      <ExtensionsCard connected={!!conn} onChanged={loadConnection} />
      <RecordingRulesCard />

      <ConnectionDialog
        key={formKey}
        open={editing}
        onOpenChange={setEditing}
        connection={conn}
        onSaved={(next) => {
          setConn(next);
          setNow(new Date());
        }}
      />
    </div>
  );
}

function StatusCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border bg-card flex min-w-0 flex-col gap-1.5 rounded-xl border p-4 text-sm">
      <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}
