'use client';

import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { CallSnapshot } from '@/hooks/use-meeting-call';

/** Why a camera, mic or screen share could not be opened. */
export function DeviceNotices({
  devices,
}: {
  devices: CallSnapshot['devices'];
}) {
  const t = useTranslations('MeetingRoom.devices');
  const rows = (['audio', 'video', 'screen'] as const).flatMap((kind) => {
    const err = devices[kind];
    return err ? [{ kind, text: t(`${kind}.${err}`) }] : [];
  });
  if (!rows.length) return null;
  return (
    <ul className="text-destructive space-y-1 text-sm">
      {rows.map((r) => (
        <li key={r.kind} className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {r.text}
        </li>
      ))}
    </ul>
  );
}
