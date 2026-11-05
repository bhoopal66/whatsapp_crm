'use client';

import { Hand, Lock, LockOpen, MicOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import type { MeetingCall } from '@/hooks/use-meeting-call';
import type { BulkModerationAction } from '@/lib/meetings/types';

import { ConfirmDialog } from './confirm-dialog';

/**
 * Room-wide controls. Each can fail on a database without migration 176,
 * so a refusal is a toast. A lock that worked needs none: the room's own
 * notice announces it. A mute is a request to each browser, so people
 * can unmute afterwards, and the wording never claims otherwise.
 */
export function RoomHostTools({
  call,
  anyHandUp,
}: {
  call: MeetingCall;
  anyHandUp: boolean;
}) {
  const t = useTranslations('MeetingRoom.panels.host');
  const [confirmMute, setConfirmMute] = useState(false);
  const [busy, setBusy] = useState(false);

  const moderateAll = async (action: BulkModerationAction, done: string) => {
    setBusy(true);
    const ok = await call.moderateAll(action);
    setBusy(false);
    if (ok) toast.success(done);
    else toast.error(t('failed'));
  };

  const toggleLock = async () => {
    setBusy(true);
    const answer = await call.setLocked(!call.locked);
    setBusy(false);
    if (answer === 'unavailable') toast.error(t('lockUnavailable'));
    else if (answer === 'failed') toast.error(t('lockFailed'));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => setConfirmMute(true)}
        >
          <MicOff />
          {t('muteAll')}
        </Button>
        {anyHandUp && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void moderateAll('lower_all_hands', t('handsLowered'))
            }
          >
            <Hand />
            {t('lowerAll')}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant={call.locked ? 'secondary' : 'outline'}
          disabled={busy}
          onClick={() => void toggleLock()}
        >
          {call.locked ? <LockOpen /> : <Lock />}
          {call.locked ? t('unlock') : t('lock')}
        </Button>
      </div>
      {call.locked && (
        <p
          role="status"
          className="bg-warning-soft text-warning flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs"
        >
          <Lock className="size-3.5 shrink-0" aria-hidden />
          {t('lockedState')}
        </p>
      )}
      <ConfirmDialog
        open={confirmMute}
        onOpenChange={setConfirmMute}
        title={t('muteAllTitle')}
        description={t('muteAllBody')}
        confirmLabel={t('muteAll')}
        onConfirm={() => void moderateAll('mute_all', t('muted'))}
      />
    </div>
  );
}
