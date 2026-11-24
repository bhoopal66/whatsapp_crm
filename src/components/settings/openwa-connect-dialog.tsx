'use client';

// ============================================================
// Settings → Numbers & access: "Connect with OpenWA".
//
// Name → Connect (POST creates the session) → poll the status route
// until the phone scans the QR → "Connected". Every decision is the
// reducer in lib/whatsapp/openwa-connect.ts; this file only renders it
// and does the fetches. Closing before the phone is linked DELETEs the
// half-made number, because an unlinked session keeps an engine and a
// scoped key alive on the gateway; when the dialog cannot know whether
// the phone linked meanwhile (it gave up, or is closed mid-poll), it
// asks once first and keeps a number that turns out linked.
//
// With `relinkConfigId` it is "Scan again" for a number whose phone was
// logged out: no name, no create, the existing session's QR, and closing
// never deletes anything (the reducer's `relink` flag).
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
  PHONE_ALREADY_CONNECTED,
  openwaPollDelayMs,
  connectReducer,
  initialConnectState,
  cleanupPlan,
  isPolling,
  openwaSessionUrls,
  openwaStatusLabelKey,
  settleUnfinishedSession,
  OPENWA_ADMIN_BASE,
} from '@/lib/whatsapp/openwa-connect';

type SessionUrls = ReturnType<typeof openwaSessionUrls>;

/**
 * Best-effort removal of a session that never linked. Returns an error
 * text, or null; `onIncomplete` runs when the row went but the gateway
 * could not be reached, so the session may still be running there.
 */
async function removeSession(
  urls: SessionUrls,
  configId: string,
  onIncomplete: () => void
): Promise<string | null> {
  try {
    const res = await fetch(urls.session(configId), {
      method: 'DELETE',
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      if (body?.gatewayCleanup === 'incomplete') onIncomplete();
      return null;
    }
    return typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : 'network error';
  }
}

/** One status read, for the late-link check; null when it did not answer. */
async function checkSession(
  urls: SessionUrls,
  configId: string
): Promise<{ status: string; phone: string | null } | null> {
  try {
    // Its own gateway read: the poll's shared one can predate a scan.
    const res = await fetch(urls.freshStatus(configId), {
      cache: 'no-store',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || typeof body?.status !== 'string') return null;
    return {
      status: body.status,
      phone: typeof body.phone === 'string' ? body.phone : null,
    };
  } catch {
    return null;
  }
}

export function OpenWAConnectDialog({
  open,
  onOpenChange,
  onConnected,
  baseUrl = OPENWA_ADMIN_BASE,
  relinkConfigId = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once when the phone is linked, to refresh the list. */
  onConnected: () => void;
  /**
   * The routes to drive: the admin's by default, or a person's own
   * (`OPENWA_PERSONAL_BASE`), which share the same shape.
   */
  baseUrl?: string;
  /** "Scan again": show this existing number's QR instead of creating one. */
  relinkConfigId?: string | null;
}) {
  const t = useTranslations('Settings.numbers');
  const urls = openwaSessionUrls(baseUrl);
  const [state, dispatch] = useReducer(connectReducer, initialConnectState);
  const [label, setLabel] = useState('');
  const [pollSeq, setPollSeq] = useState(0);
  // Bumped on every close: a POST still in flight when the admin closes
  // the dialog sees the mismatch and removes the session it created.
  const generation = useRef(0);
  // A retry awaits the late-link check before `start` guards re-entry;
  // a second click meanwhile must not settle and create twice.
  const settling = useRef(false);
  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  const polling = isPolling(state);
  const configId = state.configId;
  // Relink mode is latched in the state once it starts, so a parent that
  // drops the id mid-dialog cannot turn it into a create.
  const relinkMode = relinkConfigId !== null || state.relink;

  // One poll per tick; the next is scheduled only after this one has
  // answered, so a slow tunnel never stacks requests. The first poll
  // after create runs at once.
  // A hidden tab does not poll: it waits for the tab to be shown again.
  useEffect(() => {
    if (!polling || !configId) return;
    let alive = true;
    const delay = openwaPollDelayMs(pollSeq, document.hidden);
    if (delay === null) {
      const onVisible = () => {
        if (!document.hidden) setPollSeq((n) => n + 1);
      };
      document.addEventListener('visibilitychange', onVisible);
      return () => {
        alive = false;
        document.removeEventListener('visibilitychange', onVisible);
      };
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(openwaSessionUrls(baseUrl).status(configId), {
          cache: 'no-store',
        });
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
        } else if (
          res.status === 409 &&
          body?.code === PHONE_ALREADY_CONNECTED &&
          typeof body.error === 'string'
        ) {
          dispatch({ type: 'refused', error: body.error });
        } else {
          dispatch({ type: 'pollFailed', at: Date.now() });
        }
      } catch {
        if (alive) dispatch({ type: 'pollFailed', at: Date.now() });
      } finally {
        if (alive) setPollSeq((n) => n + 1);
      }
    }, delay);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [polling, configId, pollSeq, baseUrl]);

  useEffect(() => {
    if (state.phase === 'connected') onConnectedRef.current();
  }, [state.phase]);

  // "Scan again" starts polling as soon as the dialog opens.
  useEffect(() => {
    if (!open || !relinkConfigId || state.phase !== 'idle') return;
    setPollSeq(0);
    dispatch({ type: 'relink', configId: relinkConfigId, at: Date.now() });
  }, [open, relinkConfigId, state.phase]);

  function rescan() {
    const id = state.relink ? state.configId : relinkConfigId;
    if (!id || polling) return;
    setPollSeq(0);
    dispatch({ type: 'relink', configId: id, at: Date.now() });
  }

  async function connect() {
    if (relinkMode) return;
    if (state.phase === 'creating' || polling || settling.current) return;
    // A retry after a failed link starts a fresh session; the old one
    // would otherwise linger on the gateway.
    const gen = generation.current;
    const plan = cleanupPlan(state);
    if (plan !== 'none' && state.configId) {
      settling.current = true;
      const outcome = await settleUnfinishedSession(
        plan,
        cleanupDeps(state.configId)
      ).finally(() => {
        settling.current = false;
      });
      if (gen !== generation.current) return;
      // Scanned after the dialog gave up: that number is the one wanted.
      if (outcome?.kind === 'kept') {
        dispatch({ type: 'lateLinked', phone: outcome.phone });
        return;
      }
    }
    setPollSeq(0);
    dispatch({ type: 'start' });
    try {
      const res = await fetch(urls.create, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && typeof body?.configId === 'string') {
        if (gen !== generation.current) {
          void cleanupDeps(body.configId).remove();
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

  function cleanupDeps(id: string) {
    return {
      checkStatus: () => checkSession(urls, id),
      remove: () =>
        removeSession(urls, id, () =>
          toast.warning(t('openwa.gatewayIncomplete'))
        ),
    };
  }

  function close() {
    generation.current += 1;
    const plan = cleanupPlan(state);
    if (plan !== 'none' && state.configId) {
      const id = state.configId;
      dispatch({ type: 'cancel' });
      void settleUnfinishedSession(plan, cleanupDeps(id)).then((outcome) => {
        if (outcome?.kind === 'kept') {
          // The status route has marked it connected; show it in the list.
          toast.success(t('openwa.lateLinked'));
          onConnectedRef.current();
        } else if (outcome?.kind === 'removeFailed') {
          toast.error(t('openwa.cancelFailed', { error: outcome.error }));
        }
      });
    }
    dispatch({ type: 'reset' });
    setLabel('');
    onOpenChange(false);
  }

  const busy = state.phase === 'creating' || polling;
  const phone = state.phone?.replace(/^\+/, '');
  // On "Scan again" a passing `disconnected` is OpenWA restarting the
  // session, not a failure: label it as starting.
  const statusLabel = state.lastStatus
    ? t(
        `openwa.status.${
          state.relink && state.lastStatus === 'disconnected'
            ? 'starting'
            : openwaStatusLabelKey(state.lastStatus)
        }`
      )
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
            {relinkMode ? t('openwa.relinkTitle') : t('openwa.title')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {relinkMode ? t('openwa.relinkDesc') : t('openwa.desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {!relinkMode &&
            (state.phase === 'idle' ||
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
          {relinkMode && state.phase === 'failed' && (
            <Button onClick={rescan}>{t('openwa.retry')}</Button>
          )}
          {!relinkMode &&
            state.phase !== 'connected' &&
            state.failure !== 'notConfigured' && (
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
