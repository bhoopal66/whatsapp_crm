'use client';

import { Camera, Mic, Volume2, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { MeetingCall } from '@/hooks/use-meeting-call';
import type { MediaDeviceKind } from '@/lib/meetings/room/contract';
import {
  deviceIdFromValue,
  deviceSelectItems,
  deviceSelectValue,
  meterBars,
} from '@/lib/meetings/room-ui/lobby';
import { cn } from '@/lib/utils';

import { canPlayTones, playTones, TEST_TONE } from './room-sounds';
import { VideoTrack } from './video-track';

const METER_BARS = 10;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bg-card-2 flex flex-col gap-3 rounded-xl p-3">
      <h3 className="text-muted-foreground text-xs font-medium">{title}</h3>
      {children}
    </section>
  );
}

function DevicePicker({
  call,
  kind,
  icon: Icon,
  label,
  unnamed,
}: {
  call: MeetingCall;
  kind: MediaDeviceKind;
  icon: LucideIcon;
  label: 'camera' | 'microphone' | 'speaker';
  unnamed: 'unnamedCamera' | 'unnamedMicrophone' | 'unnamedSpeaker';
}) {
  const tl = useTranslations('MeetingRoom.lobbyV2');
  const items = deviceSelectItems(
    call.deviceOptions[kind],
    tl('systemDefault'),
    (n) => tl(unnamed, { n })
  );
  const id = `room-settings-${kind}`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{tl(label)}</Label>
      <Select
        items={items}
        value={deviceSelectValue(call.selectedDevices[kind], items)}
        onValueChange={(v) =>
          void call.selectDevice(kind, deviceIdFromValue(v))
        }
      >
        <SelectTrigger id={id} className="w-full min-w-0">
          <Icon className="text-muted-foreground" aria-hidden />
          <SelectValue className="min-w-0 truncate" />
        </SelectTrigger>
        {/* Portals to the body, outside the dialog's dark scope. */}
        <SelectContent data-mode="dark">
          {Object.entries(items).map(([value, text]) => (
            <SelectItem key={value} value={value}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Devices, a speaker test and the join/leave sound, mid-call. */
export function RoomSettingsDialog({
  call,
  open,
  onOpenChange,
  sounds,
  onSounds,
}: {
  call: MeetingCall;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sounds: boolean;
  onSounds: (on: boolean) => void;
}) {
  const t = useTranslations('MeetingRoom.panels.settings');
  const tl = useTranslations('MeetingRoom.lobbyV2');
  const [testing, setTesting] = useState(false);
  const lit = meterBars(call.localAudioLevel, METER_BARS);
  const video = call.cameraOn ? call.localVideo : null;

  const testSpeaker = async () => {
    setTesting(true);
    const ok = await playTones(TEST_TONE, {
      noteMs: 220,
      gain: 0.15,
      sinkId: call.selectedDevices.audiooutput,
    });
    setTesting(false);
    if (!ok) toast.error(t('testFailed'));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-mode="dark"
        className="max-h-[90dvh] overflow-y-auto rounded-xl sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Section title={t('audio')}>
            <DevicePicker
              call={call}
              kind="audioinput"
              icon={Mic}
              label="microphone"
              unnamed="unnamedMicrophone"
            />
            <div
              className="flex h-2 gap-0.5"
              role="meter"
              aria-label={tl('micLevel')}
              aria-valuemin={0}
              aria-valuemax={METER_BARS}
              aria-valuenow={lit}
            >
              {Array.from({ length: METER_BARS }, (_, i) => (
                <span
                  key={i}
                  className={cn(
                    'flex-1 rounded-sm transition-colors duration-150 motion-reduce:transition-none',
                    i < lit ? 'bg-success' : 'bg-muted'
                  )}
                />
              ))}
            </div>
            {call.canSelectOutput && (
              <DevicePicker
                call={call}
                kind="audiooutput"
                icon={Volume2}
                label="speaker"
                unnamed="unnamedSpeaker"
              />
            )}
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">{t('testSpeaker')}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={testing || !canPlayTones()}
                onClick={() => void testSpeaker()}
              >
                <Volume2 />
                {testing ? t('testing') : t('test')}
              </Button>
            </div>
          </Section>
          <Section title={t('video')}>
            <DevicePicker
              call={call}
              kind="videoinput"
              icon={Camera}
              label="camera"
              unnamed="unnamedCamera"
            />
            <div className="bg-background aspect-video w-40 self-center overflow-hidden rounded-xl">
              {video ? (
                <VideoTrack track={video} mirrored />
              ) : (
                <p className="text-muted-foreground flex h-full items-center justify-center p-2 text-center text-xs">
                  {t('cameraOff')}
                </p>
              )}
            </div>
            {/* BACKGROUND EFFECTS: the background picker goes here. */}
          </Section>
          <Section title={t('general')}>
            <div className="flex items-center justify-between gap-3">
              <Label
                htmlFor="room-settings-sounds"
                className="flex-col items-start"
              >
                <span>{t('sounds')}</span>
                <span className="text-muted-foreground text-xs font-normal">
                  {t('soundsHint')}
                </span>
              </Label>
              <Switch
                id="room-settings-sounds"
                checked={sounds}
                onCheckedChange={(on) => onSounds(on)}
              />
            </div>
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
