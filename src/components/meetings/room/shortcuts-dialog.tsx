'use client';

import { useTranslations } from 'next-intl';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SHORTCUT_KEYS } from '@/lib/meetings/room-ui/keys';

/** Every room shortcut: a `MeetingRoom.shortcuts` key, and its keycap. */
export const SHORTCUT_ROWS: readonly { id: string; keycap: string | null }[] = [
  { id: 'mic', keycap: SHORTCUT_KEYS.mic },
  { id: 'talk', keycap: null },
  { id: 'camera', keycap: SHORTCUT_KEYS.camera },
  { id: 'share', keycap: SHORTCUT_KEYS.share },
  { id: 'hand', keycap: SHORTCUT_KEYS.hand },
  { id: 'chat', keycap: SHORTCUT_KEYS.chat },
  { id: 'people', keycap: SHORTCUT_KEYS.people },
  { id: 'fullscreen', keycap: SHORTCUT_KEYS.fullscreen },
  { id: 'closePanel', keycap: 'Esc' },
  { id: 'shortcuts', keycap: SHORTCUT_KEYS.shortcuts },
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('MeetingRoom.shortcuts');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-mode="dark">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <dl className="flex flex-col gap-1">
          {SHORTCUT_ROWS.map((row) => (
            <div
              key={row.id}
              className="flex items-center justify-between gap-3 py-1"
            >
              <dt className="min-w-0">{t(row.id)}</dt>
              <dd>
                <kbd className="bg-card-2 border-border inline-flex h-6 min-w-6 items-center justify-center rounded-md border px-1.5 font-sans text-xs">
                  {row.keycap ?? t('space')}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
