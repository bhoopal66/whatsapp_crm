'use client';

import { ChevronUp } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { MeetingCall } from '@/hooks/use-meeting-call';
import type { MediaDeviceKind } from '@/lib/meetings/room/contract';
import {
  deviceChoices,
  deviceIdFor,
  deviceValue,
  returnFocusOnClose,
} from '@/lib/meetings/room-ui/controls';
import { cn } from '@/lib/utils';

const UNNAMED = {
  audioinput: 'unnamedMic',
  videoinput: 'unnamedCamera',
  audiooutput: 'unnamedSpeaker',
} as const;

const TITLE = {
  audioinput: 'microphone',
  videoinput: 'camera',
  audiooutput: 'speaker',
} as const;

/**
 * The chevron beside the mic or camera button: a radio list per device
 * kind. The mic's also lists speakers where the browser can route audio.
 */
export function DeviceMenu({
  call,
  kind,
  className,
}: {
  call: MeetingCall;
  kind: 'audio' | 'video';
  className?: string;
}) {
  const t = useTranslations('MeetingRoom.controlBar');
  const kinds: MediaDeviceKind[] =
    kind === 'video'
      ? ['videoinput']
      : call.canSelectOutput
        ? ['audioinput', 'audiooutput']
        : ['audioinput'];
  const label = kind === 'video' ? t('cameraOptions') : t('micOptions');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            aria-label={label}
            title={label}
            className={cn(
              'bg-card-2 text-muted-foreground hover:bg-muted dark:hover:bg-muted h-11 w-6 rounded-l-none rounded-r-xl border-l border-white/[0.06] px-0 transition-colors duration-150 ease-out motion-reduce:transition-none',
              className
            )}
          />
        }
      >
        <ChevronUp />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-mode="dark"
        side="top"
        align="start"
        sideOffset={8}
        className="w-72 rounded-xl"
        finalFocus={returnFocusOnClose}
      >
        {kinds.map((k, i) => {
          const options = call.deviceOptions[k];
          return (
            <DropdownMenuGroup key={k}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{t(TITLE[k])}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={deviceValue(call.selectedDevices[k], options)}
                onValueChange={(v) =>
                  void call.selectDevice(k, deviceIdFor(String(v)))
                }
              >
                {deviceChoices(options).map((c) => (
                  <DropdownMenuRadioItem key={c.value} value={c.value}>
                    <span className="truncate">
                      {c.ordinal === 0
                        ? t('defaultDevice')
                        : (c.label ?? t(UNNAMED[k], { n: c.ordinal }))}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
