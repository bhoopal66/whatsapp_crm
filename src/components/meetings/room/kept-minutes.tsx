'use client';

import { Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { unsavedMinutes } from '@/lib/meetings/room-ui/kept';

/**
 * Minutes this person typed that never reached the server (a conflict was
 * still open when the host ended the meeting): shown on the end screen,
 * with a Copy button, so they do not vanish with the room.
 */
export function KeptMinutes({ meetingId }: { meetingId: string }) {
  const t = useTranslations('MeetingRoom.ended');
  const { user } = useAuth();
  const text = unsavedMinutes(user?.id ?? null, meetingId);
  if (!text) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('unsavedCopied'));
    } catch {
      toast.error(t('unsavedCopyFailed'));
    }
  };
  return (
    <div className="bg-card-2 mt-4 w-full rounded-xl p-3 text-start text-sm">
      <p className="font-medium">{t('unsavedTitle')}</p>
      <p className="text-muted-foreground mt-1 max-h-32 overflow-y-auto text-xs break-words whitespace-pre-wrap">
        {text}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-2"
        onClick={() => void copy()}
      >
        <Copy />
        {t('unsavedCopy')}
      </Button>
    </div>
  );
}
