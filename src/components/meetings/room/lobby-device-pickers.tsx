'use client';

import { Camera, Mic, Volume2, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MeetingCall } from '@/hooks/use-meeting-call';
import type { MediaDeviceKind } from '@/lib/meetings/room/contract';
import {
  deviceIdFromValue,
  deviceSelectItems,
  deviceSelectValue,
} from '@/lib/meetings/room-ui/lobby';

const KINDS: {
  kind: MediaDeviceKind;
  icon: LucideIcon;
  label: 'microphone' | 'camera' | 'speaker';
  unnamed: 'unnamedMicrophone' | 'unnamedCamera' | 'unnamedSpeaker';
}[] = [
  {
    kind: 'audioinput',
    icon: Mic,
    label: 'microphone',
    unnamed: 'unnamedMicrophone',
  },
  {
    kind: 'videoinput',
    icon: Camera,
    label: 'camera',
    unnamed: 'unnamedCamera',
  },
  {
    kind: 'audiooutput',
    icon: Volume2,
    label: 'speaker',
    unnamed: 'unnamedSpeaker',
  },
];

/** Microphone, camera and (where the browser can route audio) speaker. */
export function LobbyDevicePickers({ call }: { call: MeetingCall }) {
  const t = useTranslations('MeetingRoom.lobbyV2');
  const kinds = KINDS.filter(
    (k) => k.kind !== 'audiooutput' || call.canSelectOutput
  );
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {kinds.map(({ kind, icon: Icon, label, unnamed }) => {
        const items = deviceSelectItems(
          call.deviceOptions[kind],
          t('systemDefault'),
          (n) => t(unnamed, { n })
        );
        return (
          <Select
            key={kind}
            items={items}
            value={deviceSelectValue(call.selectedDevices[kind], items)}
            onValueChange={(v) =>
              void call.selectDevice(kind, deviceIdFromValue(v))
            }
          >
            <SelectTrigger className="w-full min-w-0" aria-label={t(label)}>
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
        );
      })}
    </div>
  );
}
