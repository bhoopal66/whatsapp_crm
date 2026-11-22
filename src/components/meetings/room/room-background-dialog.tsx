'use client';

import {
  Ban,
  Droplet,
  Droplets,
  ImagePlus,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { MeetingCall } from '@/hooks/use-meeting-call';
import { imageFileToDataUrl } from '@/lib/meetings/effects/prefs';
import {
  BACKDROP_PRESETS,
  type BackgroundEffect,
} from '@/lib/meetings/effects/types';
import { cn } from '@/lib/utils';

import { VideoTrack } from './video-track';

type BackgroundCall = Pick<
  MeetingCall,
  | 'background'
  | 'backgroundBusy'
  | 'backgroundsSupported'
  | 'cameraOn'
  | 'localVideo'
  | 'setBackground'
>;

/**
 * Also offered where effects stopped working while one is still saved:
 * that camera stays off until the person can choose None.
 */
export const offersBackgrounds = (call: BackgroundCall) =>
  call.backgroundsSupported || call.background.kind !== 'none';

function sameEffect(a: BackgroundEffect, b: BackgroundEffect) {
  if (a.kind === 'blur' && b.kind === 'blur') return a.strength === b.strength;
  if (a.kind === 'color' && b.kind === 'color') return a.preset === b.preset;
  return a.kind === b.kind;
}

const TILE =
  'relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-card-2 bg-cover bg-center';

function Choice({
  label,
  selected,
  busy,
  style,
  onClick,
  children,
}: {
  label: string;
  selected: boolean;
  busy: boolean;
  style?: React.CSSProperties;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className="focus-visible:ring-ring flex min-w-0 flex-col gap-1 rounded-lg text-start outline-none focus-visible:ring-2"
      onClick={onClick}
    >
      <span
        style={style}
        className={cn(TILE, selected && 'ring-primary ring-2')}
      >
        {children}
        {selected && busy && (
          <span className="bg-overlay absolute inset-0 flex items-center justify-center">
            <Loader2 aria-hidden className="size-5 animate-spin text-white" />
          </span>
        )}
      </span>
      <span className="text-muted-foreground truncate text-xs">{label}</span>
    </button>
  );
}

export function BackgroundDialog({
  call,
  open,
  onOpenChange,
}: {
  call: BackgroundCall;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('MeetingRoom.background');
  const file = useRef<HTMLInputElement>(null);
  const [tooLarge, setTooLarge] = useState(false);
  const { background, backgroundBusy: busy } = call;
  const choose = (effect: BackgroundEffect) => {
    setTooLarge(false);
    void call.setBackground(effect);
  };
  const choice = (
    id: string,
    label: string,
    effect: BackgroundEffect,
    content?: ReactNode,
    style?: React.CSSProperties
  ) => (
    <Choice
      key={id}
      label={label}
      selected={sameEffect(background, effect)}
      busy={busy}
      style={style}
      onClick={() => choose(effect)}
    >
      {content}
    </Choice>
  );
  const upload = async (picked: File | undefined) => {
    if (!picked) return;
    const dataUrl = await imageFileToDataUrl(picked).catch(() => null);
    if (dataUrl) choose({ kind: 'image', dataUrl });
    else setTooLarge(true);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-mode="dark" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <div className="bg-card-2 relative aspect-video overflow-hidden rounded-xl">
          {call.cameraOn && call.localVideo ? (
            <VideoTrack track={call.localVideo} mirrored />
          ) : (
            <p className="text-muted-foreground flex h-full items-center justify-center p-4 text-center text-sm">
              {t('cameraOff')}
            </p>
          )}
        </div>
        <div className="grid grid-cols-4 gap-2">
          {choice('none', t('none'), { kind: 'none' }, <Ban aria-hidden />)}
          {call.backgroundsSupported && (
            <>
              {choice(
                'light',
                t('light'),
                { kind: 'blur', strength: 'light' },
                <Droplet aria-hidden />
              )}
              {choice(
                'strong',
                t('strong'),
                { kind: 'blur', strength: 'strong' },
                <Droplets aria-hidden />
              )}
              {BACKDROP_PRESETS.map((p) =>
                choice(
                  p.id,
                  t(`preset.${p.id}`),
                  { kind: 'color', preset: p.id },
                  undefined,
                  {
                    backgroundImage: `linear-gradient(135deg, ${p.stops.join(', ')})`,
                  }
                )
              )}
              {background.kind === 'image' &&
                choice('image', t('yourImage'), background, undefined, {
                  backgroundImage: `url(${background.dataUrl})`,
                })}
              <Choice
                label={t('upload')}
                selected={false}
                busy={false}
                onClick={() => file.current?.click()}
              >
                <ImagePlus aria-hidden />
              </Choice>
            </>
          )}
        </div>
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          aria-label={t('upload')}
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = ''; // the same file can be picked again
          }}
        />
        <p
          role={tooLarge ? 'alert' : undefined}
          className={cn(
            'text-xs',
            tooLarge ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {tooLarge ? t('tooLarge') : t('stored')}
        </p>
      </DialogContent>
    </Dialog>
  );
}

/** The dialog and what opens it, for the dock and the lobby alike. */
export function useBackgroundDialog(call: BackgroundCall) {
  const [open, setOpen] = useState(false);
  return {
    offered: offersBackgrounds(call),
    show: () => setOpen(true),
    dialog: <BackgroundDialog call={call} open={open} onOpenChange={setOpen} />,
  };
}

export function BackgroundButton({
  call,
  className,
}: {
  call: BackgroundCall;
  className?: string;
}) {
  const t = useTranslations('MeetingRoom.background');
  const { offered, show, dialog } = useBackgroundDialog(call);
  if (!offered) return null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className={className}
        onClick={show}
      >
        <Sparkles aria-hidden />
        {t('open')}
      </Button>
      {dialog}
    </>
  );
}
