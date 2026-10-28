'use client';

// ============================================================
// Settings → Numbers & access: "Connect with OpenWA".
//
// Name → Connect (POST creates the session) → poll the status route
// until the phone scans the QR → "Connected". Every decision is the
// reducer in lib/whatsapp/openwa-connect.ts; this file only renders it
// and does the fetches. Closing before the phone is linked DELETEs the
// half-made number, because an unlinked session keeps an engine and a
// scoped key alive on the gateway.
// ============================================================

import { useEffect, useReducer, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MAX_CHANNEL_LABEL_LEN } from '@/lib/whatsapp/channel-management';
import {
  OPENWA_POLL_INTERVAL_MS,
  connectReducer,
  initialConnectState,
  isPolling,
  needsCleanup,
  openwaStatusLabelKey,
} from '@/lib/whatsapp/openwa-connect';

const BASE = '/api/whatsapp/config/openwa';

/** Best-effort removal of a session that never linked. */
async function removeSession(configId: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/${encodeURIComponent(configId)}`, {
      method: 'DELETE',
    });
    if (res.ok) return null;
    const body = await res.json().catch(() => ({}));
    return typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : 'network error';
  }
}

export function OpenWAConnectDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once when the phone is linked, to refresh the list. */
  onConnected: () => void;
}) {
  const t = useTranslations('Settings.numbers');
  const [state, dispatch] = useReducer(connectReducer, initialConnectState);
  const [label, setLabel] = useState('');
  const [pollSeq, setPollSeq] = useState(0);
  // Bumped on every close: a POST still in flight when the admin closes
  // the dialog sees the mismatch and removes the session it created.
  const generation = useRef(0);
  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  const polling = isPolling(state);
  const configId = state.configId;

  // One poll per tick; the next is scheduled only after this one has
  // answered, so a slow tunnel never stacks requests. The first poll
  // after create runs at once.
  useEffect(() => {
    if (!polling || !configId) return;
    let alive = true;
    const timer = setTimeout(
      async () => {
        try {
          const res = await fetch(
            `${BASE}/${encodeURIComponent(configId)}/status`,
            { cache: 'no-store' }
          );
          const body = await res.json().catch(() => ({}));
          if (!alive) return;
          if (res.ok && typeof body?.status === 'string') {
            dispatch({
              type: 'polled',
              status: body.status,
              qrCode: typeof body.qrCode === 'string' ? body.qrCode : null,
              phone: typeof body.phone === 'string' ? body.phone : null,
              at: Date.now(),
            });
          } else {
            dispatch({ type: 'pollFailed', at: Date.now() });
          }
        } catch {
          if (alive) dispatch({ type: 'pollFailed', at: Date.now() });
        } finally {
          if (alive) setPollSeq((n) => n + 1);
        }
      },
      pollSeq === 0 ? 0 : OPENWA_POLL_INTERVAL_MS
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [polling, configId, pollSeq]);

  useEffect(() => {
    if (state.phase === 'connected') onConnectedRef.current();
  }, [state.phase]);

  async function connect() {
    if (state.phase === 'creating' || polling) return;
    // A retry after a failed link starts a fresh session; the old one
    // would otherwise linger on the gateway.
    if (needsCleanup(state) && state.configId) {
      void removeSession(state.configId);
    }
    const gen = generation.current;
    setPollSeq(0);
    dispatch({ type: 'start' });
    try {
      const res = await fetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && typeof body?.configId === 'string') {
        if (gen !== generation.current) {
          void removeSession(body.configId);
          return;
        }
        dispatch({ type: 'created', configId: body.configId, at: Date.now() });
        return;
      }
      if (gen !== generation.current) return;
      dispatch({
        type: 'createFailed',
        notConfigured: body?.error === 'openwa_not_configured',
        error: typeof body?.error === 'string' ? body.error : undefined,
      });
    } catch {
      if (gen === generation.current) {
        dispatch({ type: 'createFailed', notConfigured: false });
      }
    }
  }

  function close() {
    generation.current += 1;
    if (needsCleanup(state) && state.configId) {
      const id = state.configId;
      dispatch({ type: 'cancel' });
      void removeSession(id).then((error) => {
        if (error) toast.error(t('openwa.cancelFailed', { error }));
      });
    }
    dispatch({ type: 'reset' });
    setLabel('');
    onOpenChange(false);
  }

  const busy = state.phase === 'creating' || polling;
  const phone = state.phone?.replace(/^\+/, '');
  const statusLabel = state.lastStatus
    ? t(`openwa.status.${openwaStatusLabelKey(state.lastStatus)}`)
    : null;

  let failureText: string | null = null;
  if (state.phase === 'failed') {
    failureText =
      state.failure === 'notConfigured'
        ? t('openwa.notConfigured')
        : state.failure === 'timedOut'
          ? t('openwa.timedOut')
          : state.failure === 'notLinked'
            ? t('openwa.notLinked', { status: statusLabel ?? '' })
            : state.error || t('openwa.createFailed');
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('openwa.title')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('openwa.desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {(state.phase === 'idle' ||
            state.phase === 'creating' ||
            state.phase === 'failed') && (
            <div className="space-y-1.5">
              <Label htmlFor="openwa-number-name">{t('nameLabel')}</Label>
              <Input
                id="openwa-number-name"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={MAX_CHANNEL_LABEL_LEN}
                placeholder={t('namePlaceholder')}
                disabled={busy}
                className="border-border text-foreground"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void connect();
                  }
                }}
              />
            </div>
          )}

          {(state.phase === 'creating' || state.phase === 'waitingForQr') && (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              {state.phase === 'creating'
                ? t('openwa.creating')
                : (statusLabel ?? t('openwa.status.starting'))}
            </p>
          )}

          {state.phase === 'showingQr' && state.qrCode && (
            <div className="flex flex-col items-center gap-3">
              {/* A white plate behind the code in both modes: a QR on a
                  dark surface does not scan reliably. */}
              {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL; next/image adds nothing */}
              <img
                src={state.qrCode}
                alt={t('openwa.qrAlt')}
                className="border-border size-56 rounded-md border bg-white p-2"
              />
              <p className="text-foreground text-center text-sm">
                {t('openwa.steps')}
              </p>
              {statusLabel && (
                <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <Loader2 className="size-3 animate-spin" />
                  {statusLabel}
                </p>
              )}
            </div>
          )}

          {state.phase === 'linking' && (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              {t('openwa.status.linking')}
            </p>
          )}

          {state.phase === 'connected' && (
            <p className="border-success/30 bg-success-soft text-success flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <CheckCircle2 className="size-4 shrink-0" />
              {phone
                ? t('openwa.connected', { phone })
                : t('openwa.connectedNoPhone')}
            </p>
          )}

          {failureText && (
            <p className="border-destructive/30 bg-destructive-soft text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0">{failureText}</span>
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {state.phase === 'connected' ? t('openwa.close') : t('cancel')}
          </Button>
          {state.phase !== 'connected' && state.failure !== 'notConfigured' && (
            <Button onClick={() => void connect()} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {state.phase === 'failed'
                ? t('openwa.retry')
                : t('openwa.connect')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
