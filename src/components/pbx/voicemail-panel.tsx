'use client';

// The caller's own voicemail box (replacing the Linkus app's): newest
// first, played through /api/pbx/voicemail/[id]/audio so the browser
// never sees the PBX's token-bearing link. Playing marks a message read;
// Delete asks first; Call back dials the caller's number with the usual
// CallButton (hidden for a person with no extension). The server only
// ever reads the caller's own extension, so nothing here names one.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  markedRead,
  removed,
  voicemailAudioPath,
  voicemailCaller,
  voicemailDuration,
  voicemailTime,
  type VoicemailItem,
  type VoicemailListResponse,
} from '@/lib/pbx/voicemail';
import { CallButton } from './call-button';

type Load =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'noExtension' }
  | { state: 'ready'; list: VoicemailListResponse };

export function VoicemailPanel() {
  const t = useTranslations('Voicemail');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [confirming, setConfirming] = useState<VoicemailItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const marking = useRef(new Set<string>());

  const seq = useRef(0);

  const refresh = useCallback(async () => {
    // Only the newest request may write: an older response never
    // overwrites a newer one.
    const n = ++seq.current;
    setLoad({ state: 'loading' });
    try {
      const res = await fetch('/api/pbx/voicemail', { cache: 'no-store' });
      if (res.status === 409) {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;
        if (n !== seq.current) return;
        if (body?.code === 'no_extension') {
          setLoad({ state: 'noExtension' });
          return;
        }
      }
      if (!res.ok) throw new Error(String(res.status));
      const list = await res.json();
      if (n === seq.current) setLoad({ state: 'ready', list });
    } catch {
      if (n === seq.current) setLoad({ state: 'error' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const markRead = useCallback(async (m: VoicemailItem) => {
    if (m.read || marking.current.has(m.id)) return;
    marking.current.add(m.id);
    try {
      const res = await fetch(
        `/api/pbx/voicemail/${encodeURIComponent(m.id)}/read`,
        { method: 'POST' }
      );
      if (res.ok)
        setLoad((l) =>
          l.state === 'ready' ? { ...l, list: markedRead(l.list, m.id) } : l
        );
    } finally {
      marking.current.delete(m.id);
    }
  }, []);

  async function confirmDelete() {
    const m = confirming;
    if (!m) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/pbx/voicemail/${encodeURIComponent(m.id)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) throw new Error(String(res.status));
      setLoad((l) =>
        l.state === 'ready' ? { ...l, list: removed(l.list, m.id) } : l
      );
      toast.success(t('deleted'));
      setConfirming(null);
    } catch {
      toast.error(t('deleteFailed'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{t('title')}</h2>
          {load.state === 'ready' && (
            <p className="text-muted-foreground text-sm">
              {t('unreadCount', { count: load.list.unread })}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('refresh')}
          title={t('refresh')}
          disabled={load.state === 'loading'}
          onClick={() => void refresh()}
        >
          <RefreshCw />
        </Button>
      </header>

      {load.state === 'loading' && (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="animate-spin" />
          {t('loading')}
        </p>
      )}
      {load.state === 'error' && (
        <div className="text-destructive flex items-center gap-2 text-sm">
          {t('loadFailed')}
          <Button variant="outline" size="xs" onClick={() => void refresh()}>
            {t('retry')}
          </Button>
        </div>
      )}
      {load.state === 'noExtension' && (
        <p className="text-muted-foreground text-sm">{t('noExtension')}</p>
      )}
      {load.state === 'ready' && load.list.messages.length === 0 && (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      )}
      {load.state === 'ready' && load.list.messages.length > 0 && (
        <>
          <ul className="bg-card divide-y rounded-lg border">
            {load.list.messages.map((m) => (
              <VoicemailRow
                key={m.id}
                message={m}
                onPlay={() => void markRead(m)}
                onDelete={() => setConfirming(m)}
              />
            ))}
          </ul>
          {load.list.total > load.list.messages.length && (
            <p className="text-muted-foreground text-xs">
              {t('firstPage', {
                shown: load.list.messages.length,
                total: load.list.total,
              })}
            </p>
          )}
        </>
      )}

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setConfirming(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>{t('deleteBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deleting}
              onClick={() => setConfirming(null)}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              {deleting ? t('deleting') : t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function VoicemailRow({
  message: m,
  onPlay,
  onDelete,
}: {
  message: VoicemailItem;
  onPlay: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('Voicemail');
  const locale = useLocale();
  const [audioFailed, setAudioFailed] = useState(false);
  const caller = voicemailCaller(m);
  const name = caller?.primary ?? t('withheld');
  const when = voicemailTime(m.at, locale);

  return (
    <li className="space-y-2 p-3">
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className={`mt-1.5 size-2 shrink-0 rounded-full ${
            m.read ? 'bg-transparent' : 'bg-primary'
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            {m.contactId ? (
              <Link
                href={`/contacts/${m.contactId}`}
                title={t('openContact')}
                className={`truncate hover:underline ${
                  m.read ? 'font-medium' : 'font-semibold'
                }`}
              >
                {name}
              </Link>
            ) : (
              <span
                className={`truncate ${
                  m.read ? 'font-medium' : 'font-semibold'
                }`}
              >
                {name}
              </span>
            )}
            {caller?.secondary && (
              <span className="text-muted-foreground text-sm">
                {caller.secondary}
              </span>
            )}
            {!m.read && (
              <span className="text-primary text-xs font-medium">
                {t('unread')}
              </span>
            )}
          </div>
          <p className="text-muted-foreground text-xs">
            {when && <span>{when} · </span>}
            {t('duration', { duration: voicemailDuration(m.durationSeconds) })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {m.callerNumber.trim() && (
            <CallButton
              number={m.callerNumber.trim()}
              label={t('callBack')}
              size="xs"
            />
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('delete')}
            title={t('delete')}
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      <audio
        controls
        preload="none"
        src={voicemailAudioPath(m.id)}
        className="h-8 w-full"
        onPlay={onPlay}
        onError={() => setAudioFailed(true)}
      />
      {audioFailed && (
        <p className="text-destructive text-xs">{t('audioFailed')}</p>
      )}
    </li>
  );
}
