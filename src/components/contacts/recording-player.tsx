'use client';

// A call's recording on the customer page (module 015). Play asks the
// server for a five-minute signed link, which logs the play and refuses
// (409) a recording held until the notice is confirmed, erased, or
// deleted under the retention period since the page loaded; the 409's
// `code` says which (refusalView). The audio then plays in this
// element. A team leader and up can also download it (Download): the
// route logs a download and signs a five-minute link for it, refused
// (403) below a leader and on the same 409s. An owner or admin can
// place or lift a legal hold (migration 093), with a reason: a held
// recording outlives the retention period and blocks erasure. A
// recording held for the notice still exists, so its box keeps the
// legal hold controls; a hold refused because the audio is gone
// (deleted under the period, erased, not stored) shows that state
// instead (noAudioView). Lifting the hold
// of a recording already past the period deletes it on the next cron
// run: the route refuses that (409 past_retention) until the warning
// shown here is confirmed (confirmDelete).

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Check,
  Download,
  Loader2,
  Paperclip,
  Pause,
  Play,
  Scale,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { canDownloadRecording, canPlaceLegalHold } from '@/lib/auth/roles';
import { reasonOk } from '@/lib/chat/admin-tools';
import {
  noAudioView,
  playerClock,
  recordingView,
  refusalView,
  type RecordingView,
  type TimelineCall,
} from '@/lib/pbx/timeline';

const NOTE: Record<Exclude<RecordingView, 'player'>, string> = {
  held: 'recordingHeld',
  erased: 'recordingErased',
  pending: 'recordingPending',
  notStored: 'recordingNotStored',
  expired: 'recordingExpired',
};

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export function RecordingPlayer({
  call,
  dealId,
}: {
  call: TimelineCall;
  dealId: string | null;
}) {
  const t = useTranslations('CustomerTimeline');
  const audio = useRef<HTMLAudioElement>(null);
  // What a 409 said the recording is now; null: not refused.
  const [refused, setRefused] = useState<RecordingView | null>(null);
  const [linked, setLinked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [length, setLength] = useState<number | null>(null);
  const [attach, setAttach] = useState<'idle' | 'busy' | 'done'>('idle');
  const { accountRole } = useAuth();
  const canHold = !!accountRole && canPlaceLegalHold(accountRole);
  const canDownload = !!accountRole && canDownloadRecording(accountRole);
  const [downloading, setDownloading] = useState(false);
  const [hold, setHold] = useState(call.legalHold === true);
  // null: closed; a string: the reason being typed.
  const [holdReason, setHoldReason] = useState<string | null>(null);
  const [holdBusy, setHoldBusy] = useState(false);
  // The period (days) a lift would delete under, once the route warned.
  const [liftDeletes, setLiftDeletes] = useState<number | null>(null);

  const held = refused === 'held';
  const view: RecordingView | undefined =
    refused && !held ? refused : recordingView(call);
  if (!view) return null;
  if (view !== 'player')
    return (
      <p className="text-muted-foreground mt-2 text-xs italic">
        {t(NOTE[view] as never)}
      </p>
    );

  const toggle = async () => {
    const el = audio.current;
    if (!el || busy) return;
    if (playing) return el.pause();
    setBusy(true);
    try {
      if (!linked) {
        const res = await post(`/api/pbx/calls/${call.id}/recording`, {
          action: 'play',
        });
        if (res.status === 409) {
          const why = await res.json().catch(() => null);
          return setRefused(refusalView(why?.code));
        }
        const body = res.ok ? await res.json().catch(() => null) : null;
        if (typeof body?.url !== 'string') throw new Error('no link');
        el.src = body.url;
        setLinked(true);
      }
      await el.play();
    } catch {
      toast.error(t('playFailed'));
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await post(`/api/pbx/calls/${call.id}/recording`, {
        action: 'download',
      });
      if (res.status === 409) {
        const why = await res.json().catch(() => null);
        return setRefused(refusalView(why?.code));
      }
      const body = res.ok ? await res.json().catch(() => null) : null;
      if (typeof body?.url !== 'string') throw new Error('no link');
      // Signed for download (an attachment), so the page stays put.
      const a = document.createElement('a');
      a.href = body.url;
      a.rel = 'noopener';
      a.click();
    } catch {
      toast.error(t('downloadFailed'));
    } finally {
      setDownloading(false);
    }
  };

  const attachToDeal = async () => {
    if (!dealId || attach !== 'idle') return;
    setAttach('busy');
    const res = await post(`/api/pbx/calls/${call.id}/attach`, {
      dealId,
    }).catch(() => null);
    if (res?.ok) {
      setAttach('done');
      toast.success(t('attached'));
      return;
    }
    setAttach('idle');
    if (res?.status === 409) {
      const why = await res.json().catch(() => null);
      setRefused(refusalView(why?.code));
    }
    toast.error(t('attachFailed'));
  };

  const changeHold = async () => {
    if (holdReason === null || !reasonOk(holdReason) || holdBusy) return;
    setHoldBusy(true);
    const res = await fetch(`/api/pbx/calls/${call.id}/legal-hold`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hold: !hold,
        reason: holdReason,
        ...(liftDeletes !== null ? { confirmDelete: true } : {}),
      }),
    }).catch(() => null);
    setHoldBusy(false);
    const body = res ? await res.json().catch(() => null) : null;
    if (res?.status === 409 && body?.code === 'past_retention') {
      setLiftDeletes(Number(body.retentionDays) || 0);
      return;
    }
    // The audio went since the page loaded: say how, without the hold
    // control, as a refused play does. Nothing is left to hold.
    const gone = res?.status === 409 ? noAudioView(body?.code) : null;
    if (gone) {
      setHoldReason(null);
      setLiftDeletes(null);
      setRefused(gone);
      toast.error(t('holdFailed'));
      return;
    }
    if (!res?.ok || typeof body?.legalHold !== 'boolean') {
      toast.error(t('holdFailed'));
      return;
    }
    setHold(body.legalHold);
    setHoldReason(null);
    setLiftDeletes(null);
    toast.success(t(body.legalHold ? 'holdPlaced' : 'holdLifted'));
  };

  const total = length ?? call.talkSeconds ?? 0;
  const pct = total > 0 ? Math.min(100, (at / total) * 100) : 0;
  return (
    <div className="border-border bg-muted/40 mt-2 rounded-lg border p-3">
      {held ? (
        <p className="text-muted-foreground text-xs italic">
          {t('recordingHeld')}
        </p>
      ) : (
        <div className="flex items-center gap-3">
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={playing ? t('pause') : t('play')}
            onClick={() => void toggle()}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : playing ? (
              <Pause className="size-4" />
            ) : (
              <Play className="size-4" />
            )}
          </Button>
          <div className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full">
            <div
              className="h-full rounded-full bg-emerald-600"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-muted-foreground font-mono text-xs tabular-nums">
            {playerClock(at)} / {playerClock(total)}
          </span>
        </div>
      )}
      {/* The src is set by Play, never rendered: the link is signed per play. */}
      <audio
        ref={audio}
        preload="none"
        className="hidden"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          setLength(Number.isFinite(d) ? d : null);
        }}
        // An expired link: the next Play asks for a fresh one.
        onError={() => setLinked(false)}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          {!held && t('noticePlayed')}
          {hold && (
            <span className="ml-2 rounded-md bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900 [[data-mode=dark]_&]:bg-amber-500/15 [[data-mode=dark]_&]:text-amber-200">
              {t('legalHold')}
            </span>
          )}
        </p>
        {canHold && holdReason === null && (
          <Button size="xs" variant="outline" onClick={() => setHoldReason('')}>
            <Scale className="size-3.5" />
            {hold ? t('liftHold') : t('placeHold')}
          </Button>
        )}
        {canDownload && !held && (
          <Button
            size="xs"
            variant="outline"
            disabled={downloading}
            onClick={() => void download()}
          >
            {downloading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            {t('download')}
          </Button>
        )}
        {dealId && !held && (
          <Button
            size="xs"
            variant="outline"
            disabled={attach !== 'idle'}
            onClick={() => void attachToDeal()}
          >
            {attach === 'done' ? (
              <Check className="size-3.5" />
            ) : (
              <Paperclip className="size-3.5" />
            )}
            {attach === 'done' ? t('attached') : t('attach')}
          </Button>
        )}
      </div>
      {canHold && holdReason !== null && liftDeletes !== null && (
        <p className="text-destructive mt-2 text-xs">
          {t('liftDeletes', { days: liftDeletes })}
        </p>
      )}
      {canHold && holdReason !== null && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            className="bg-card h-7 min-w-0 flex-1 text-xs"
            value={holdReason}
            placeholder={t('holdReason')}
            aria-label={t('holdReason')}
            onChange={(e) => setHoldReason(e.target.value)}
          />
          <Button
            size="xs"
            variant={liftDeletes !== null ? 'destructive' : 'default'}
            disabled={!reasonOk(holdReason) || holdBusy}
            onClick={() => void changeHold()}
          >
            {holdBusy && <Loader2 className="size-3.5 animate-spin" />}
            {liftDeletes !== null
              ? t('liftAndDelete')
              : hold
                ? t('liftHold')
                : t('placeHold')}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={holdBusy}
            onClick={() => {
              setHoldReason(null);
              setLiftDeletes(null);
            }}
          >
            {t('holdCancel')}
          </Button>
        </div>
      )}
    </div>
  );
}
