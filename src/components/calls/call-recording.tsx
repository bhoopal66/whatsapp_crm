'use client';

// A call's recording on the Calls list (lib/pbx/list-player). The row
// carries a compact Play; pressing it opens the customer page's player
// under the row, which asks the recording route for its signed link
// there and then (autoStart). The player keeps every rule of the
// customer page: the play is logged, a held, erased or expired
// recording is refused with the same words, and Download is offered to
// a team leader and up.

import { useTranslations } from 'next-intl';
import { ChevronUp, Play } from 'lucide-react';

import { RecordingPlayer } from '@/components/contacts/recording-player';
import { Button } from '@/components/ui/button';
import { listPlayerOffered } from '@/lib/pbx/list-player';
import type { TimelineCall } from '@/lib/pbx/timeline';

export const recordingPanelId = (callId: string) => `call-recording-${callId}`;

export function CallRecordingToggle({
  call,
  open,
  onToggle,
}: {
  call: Pick<TimelineCall, 'id' | 'recordingState' | 'recordingDeleted'>;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('CallsPage');
  if (!listPlayerOffered(call)) return null;
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="text-muted-foreground shrink-0 rounded-full"
      aria-label={open ? t('hideRecording') : t('playRecording')}
      aria-expanded={open}
      aria-controls={open ? recordingPanelId(call.id) : undefined}
      onClick={onToggle}
    >
      {open ? <ChevronUp className="size-4" /> : <Play className="size-4" />}
    </Button>
  );
}

export function CallRecordingPanel({ call }: { call: TimelineCall }) {
  return (
    <div id={recordingPanelId(call.id)} className="min-w-0 sm:ml-12">
      <RecordingPlayer call={call} dealId={null} autoStart />
    </div>
  );
}
