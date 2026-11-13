'use client';

// ============================================================
// Settings → Profile: "My WhatsApp" (migration 190).
//
// A person an admin allowed connects their own phone through OpenWA,
// with the same connect dialog the admin uses, pointed at the personal
// routes. Which face shows is `myWhatsAppView` (lib/whatsapp/my-whatsapp);
// this file renders it and does the fetches. Hidden from everyone who
// is neither allowed nor holding a number, bank guests included (the
// route answers them 403).
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Smartphone } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { invalidateCached } from '@/lib/client-cache';
import {
  OPENWA_PERSONAL_BASE,
  isLinkedStatus,
  numberLinked,
  openwaSessionUrls,
} from '@/lib/whatsapp/openwa-connect';
import {
  IMPORT_POLL_MS,
  importLine,
  isImportActive,
  myWhatsAppView,
  parsePersonalNumberInfo,
  type PersonalNumberInfo,
} from '@/lib/whatsapp/my-whatsapp';
import { OpenWAConnectDialog } from './openwa-connect-dialog';

export function MyWhatsAppCard() {
  const t = useTranslations('Settings.myWhatsApp');
  const [info, setInfo] = useState<PersonalNumberInfo | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [rescanOpen, setRescanOpen] = useState(false);
  // OpenWA's live word for the number (`ready`, `qr_ready`, …); null
  // until it answers, when the saved status stands in.
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Loads overlap (the import poll, a connect); only the newest may set
  // state, or an older `qr_ready` could land over a fresh `ready`.
  const loadSeq = useRef(0);
  // The number `liveStatus` belongs to.
  const liveFor = useRef<string | null>(null);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const res = await fetch(OPENWA_PERSONAL_BASE, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (seq !== loadSeq.current) return;
      const next = res.ok ? parsePersonalNumberInfo(body) : null;
      setInfo(next);
      setLiveStatus((prev) =>
        next?.number && next.number.id === liveFor.current ? prev : null
      );
      liveFor.current = next?.number?.id ?? null;
      if (!next?.number) return;
      // The saved status lags the phone by up to a sweep (5 min); the
      // badge and "Scan again" follow what the gateway says now.
      const live = await fetch(
        openwaSessionUrls(OPENWA_PERSONAL_BASE).status(next.number.id),
        { cache: 'no-store' }
      )
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (seq !== loadSeq.current) return;
      setLiveStatus(typeof live?.status === 'string' ? live.status : null);
    } catch {
      if (seq === loadSeq.current) setInfo(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-read while the history import is moving; stops once it settles.
  const importActive = isImportActive(info?.import ?? null);
  useEffect(() => {
    if (!importActive) return;
    const timer = setInterval(() => void load(), IMPORT_POLL_MS);
    return () => clearInterval(timer);
  }, [importActive, load]);

  const onConnected = useCallback(() => {
    invalidateCached('whatsapp-channels:');
    void load();
  }, [load]);

  async function disconnect(id: string) {
    setRemoving(true);
    try {
      const res = await fetch(
        openwaSessionUrls(OPENWA_PERSONAL_BASE).session(id),
        { method: 'DELETE' }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          typeof body?.error === 'string' ? body.error : t('removeFailed')
        );
        return;
      }
      if (body?.gatewayCleanup === 'incomplete') {
        toast.warning(t('gatewayIncomplete'));
      } else {
        toast.success(t('removed'));
      }
      setConfirmOpen(false);
      invalidateCached('whatsapp-channels:');
      await load();
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setRemoving(false);
    }
  }

  const view = myWhatsAppView(info);
  if (view.kind === 'hidden') return null;
  const line = importLine(info?.import ?? null);

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-3">
          <Smartphone className="text-muted-foreground mt-0.5 size-5 shrink-0" />
          <div className="min-w-0 space-y-1">
            <h3 className="text-foreground text-sm font-semibold">
              {t('title')}
            </h3>
            <p className="text-muted-foreground text-sm">{t('explainer')}</p>
          </div>
        </div>

        {view.kind === 'notConfigured' && (
          <p className="text-muted-foreground text-sm">{t('notConfigured')}</p>
        )}

        {view.kind === 'connect' && (
          <Button onClick={() => setConnectOpen(true)}>{t('connect')}</Button>
        )}

        {view.kind === 'connected' && (
          <div className="border-border bg-card-2 flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2">
            <div className="min-w-0 space-y-0.5">
              <p className="text-foreground truncate text-sm font-medium">
                {view.number.label || t('defaultLabel')}
              </p>
              <p className="text-muted-foreground text-xs">
                {view.number.phone
                  ? `+${view.number.phone.replace(/^\+/, '')}`
                  : t('noPhone')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {numberLinked(view.number.status, liveStatus) ? (
                <Badge className="bg-success-soft text-success">
                  {t('statusConnected')}
                </Badge>
              ) : (
                <Badge className="bg-destructive-soft text-destructive">
                  {t('statusDisconnected')}
                </Badge>
              )}
              {liveStatus !== null && !isLinkedStatus(liveStatus) && (
                <Button onClick={() => setRescanOpen(true)}>
                  {t('scanAgain')}
                </Button>
              )}
              <Button variant="outline" onClick={() => setConfirmOpen(true)}>
                {t('disconnect')}
              </Button>
            </div>
          </div>
        )}

        {view.kind === 'connected' && (
          <div className="space-y-1">
            {line && (
              <p
                className={
                  line.key === 'failed'
                    ? 'text-destructive text-sm'
                    : 'text-foreground text-sm'
                }
              >
                {line.key === 'preparing' && t('importPreparing')}
                {line.key === 'running' &&
                  t('importRunning', {
                    done: line.done,
                    total: line.total,
                    messages: line.messages,
                  })}
                {line.key === 'paused' && t('importPaused')}
                {line.key === 'done' &&
                  t('importDone', {
                    total: line.total,
                    messages: line.messages,
                  })}
                {line.key === 'failed' &&
                  t('importFailed', { error: line.error })}
              </p>
            )}
            <p className="text-muted-foreground text-xs">
              {t('importExplainer')}
            </p>
          </div>
        )}
      </CardContent>

      <OpenWAConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={onConnected}
        baseUrl={OPENWA_PERSONAL_BASE}
      />

      <OpenWAConnectDialog
        open={rescanOpen}
        onOpenChange={setRescanOpen}
        onConnected={onConnected}
        baseUrl={OPENWA_PERSONAL_BASE}
        relinkConfigId={
          rescanOpen && view.kind === 'connected' ? view.number.id : null
        }
      />

      <Dialog
        open={confirmOpen}
        onOpenChange={(o) => !o && !removing && setConfirmOpen(false)}
      >
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('removeTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('removeBody')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={removing}
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={() =>
                view.kind === 'connected' && void disconnect(view.number.id)
              }
              disabled={removing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removing ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('disconnect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
