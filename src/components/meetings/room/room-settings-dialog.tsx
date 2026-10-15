'use client';

import { Camera, Mic, Volume2, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
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
import {
  JOIN_LEAVE_SOUNDS_KEY,
  parseSoundPref,
} from '@/lib/meetings/room-ui/panels';
import { cn } from '@/lib/utils';

import { canPlayTones, playTones, TEST_TONE } from './room-sounds';

function readSoundPref(): boolean {
  try {
    return parseSoundPref(localStorage.getItem(JOIN_LEAVE_SOUNDS_KEY));
  } catch {
    return false;
  }
}

/** The join/leave sound switch, kept in localStorage; off by default. */
export function useJoinLeaveSounds(): [boolean, (on: boolean) => void] {
  // Only the live room mounts this, never the server render.
  const [on, setOn] = useState(readSoundPref);
  const set = useCallback((next: boolean) => {
    setOn(next);
    try {
      localStorage.setItem(JOIN_LEAVE_SOUNDS_KEY, next ? '1' : '0');
    } catch {
      // Private mode or full storage: the choice lasts this visit only.
    }
  }, []);
  return [on, set];
}

const KINDS: {
  kind: MediaDeviceKind;
  icon: LucideIcon;
  label: 'camera' | 'microphone' | 'speaker';
  unnamed: 'unnamedCamera' | 'unnamedMicrophone' | 'unnamedSpeaker';
}[] = [
  {
    kind: 'videoinput',
    icon: Camera,
    label: 'camera',
    unnamed: 'unnamedCamera',
  },
  {
    kind: 'audioinput',
    icon: Mic,
    label: 'microphone',
    unnamed: 'unnamedMicrophone',
  },
  {
    kind: 'audiooutput',
    icon: Volume2,
    label: 'speaker',
    unnamed: 'unnamedSpeaker',
  },
];

const METER_BARS = 10;

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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {KINDS.filter(
            (k) => k.kind !== 'audiooutput' || call.canSelectOutput
          ).map(({ kind, icon: Icon, label, unnamed }) => {
            const items = deviceSelectItems(
              call.deviceOptions[kind],
              tl('systemDefault'),
              (n) => tl(unnamed, { n })
            );
            const id = `room-settings-${kind}`;
            return (
              <div key={kind} className="flex flex-col gap-1.5">
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
                  <SelectContent>
                    {Object.entries(items).map(([value, text]) => (
                      <SelectItem key={value} value={value}>
                        {text}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {kind === 'audioinput' && (
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
                          'flex-1 rounded-sm',
                          i < lit ? 'bg-emerald-500' : 'bg-muted'
                        )}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
