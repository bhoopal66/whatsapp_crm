'use client';

// A call's recording on the customer page (module 015). Play asks the
// server for a five-minute signed link, which logs the play and refuses
// (409) a recording held until the notice is confirmed or erased; the
// audio then plays in this element. Nothing is downloaded.

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, Loader2, Paperclip, Pause, Play } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { playerClock, type TimelineCall } from '@/lib/pbx/timeline';

type View = 'player' | 'held' | 'erased' | 'pending' | 'notStored';

/** calls.recording_state → what the box shows; none/failed: no box. */
const VIEW: Record<string, View> = {
  fetched: 'player',
  held: 'held',
  erased: 'erased',
  pending: 'pending',
  not_stored: 'notStored',
};
const NOTE: Record<Exclude<View, 'player'>, string> = {
  held: 'recordingHeld',
  erased: 'recordingErased',
  pending: 'recordingPending',
  notStored: 'recordingNotStored',
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
  const [refused, setRefused] = useState(false);
  const [linked, setLinked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [length, setLength] = useState<number | null>(null);
  const [attach, setAttach] = useState<'idle' | 'busy' | 'done'>('idle');

  const view: View | undefined = refused ? 'held' : VIEW[call.recordingState];
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
        if (res.status === 409) return setRefused(true);
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
    if (res?.status === 409) setRefused(true);
    toast.error(t('attachFailed'));
  };

  const total = length ?? call.talkSeconds ?? 0;
  const pct = total > 0 ? Math.min(100, (at / total) * 100) : 0;
  return (
    <div className="border-border bg-muted/40 mt-2 rounded-lg border p-3">
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
        <p className="text-muted-foreground text-xs">{t('noticePlayed')}</p>
        {dealId && (
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
    </div>
  );
}
