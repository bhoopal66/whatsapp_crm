'use client';

import { useState } from 'react';
import { Info, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { putConversationSendChannel } from '@/lib/inbox/switch-send-channel';
import {
  newChatNoticeWording,
  type NewChatNotice,
} from '@/lib/team-activity/new-chat-notice';
import { cn } from '@/lib/utils';

/** The reminder's words: the admin's text verbatim, else the default. */
export function NewChatNoticeText({ notice }: { notice: NewChatNotice }) {
  const t = useTranslations('TeamActivity.newChatNotice');
  const wording = newChatNoticeWording(notice);
  return (
    <>
      {wording.kind === 'custom'
        ? wording.text
        : wording.kind === 'named'
          ? t('defaultNamed', { name: wording.name })
          : t('default')}
    </>
  );
}

/**
 * The standing "use the marketing number" reminder (migration 207).
 * Persistent: no dismiss. In the inbox it can pin the chat to the
 * marketing number; once the chat's row comes back pinned the thread
 * stops rendering it, and until then it says the switch is done.
 */
export function NewChatNoticeCard({
  notice,
  conversationId,
  canSwitch = false,
  onSwitched,
  className,
}: {
  notice: NewChatNotice;
  /** Absent in the New chat dialog: no chat to pin yet. */
  conversationId?: string;
  canSwitch?: boolean;
  onSwitched?: () => void;
  className?: string;
}) {
  const t = useTranslations('TeamActivity.newChatNotice');
  const tSwitch = useTranslations('Inbox.channelSwitch');
  const [saving, setSaving] = useState(false);
  // Tagged with its chat, so another chat never inherits "switched".
  const [switchedFor, setSwitchedFor] = useState<string | null>(null);
  const switched = !!conversationId && switchedFor === conversationId;

  async function switchNow() {
    if (!conversationId || !notice.channelId || saving) return;
    setSaving(true);
    try {
      const result = await putConversationSendChannel(
        conversationId,
        notice.channelId
      );
      if (!result.ok) {
        toast.error(result.error || tSwitch('failed'));
        return;
      }
      setSwitchedFor(conversationId);
      toast.success(t('switched'));
      onSwitched?.();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="note"
      className={cn(
        'bg-info-soft text-info flex items-start gap-2 px-3 py-2 text-xs sm:px-4',
        className
      )}
    >
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {switched ? t('switched') : <NewChatNoticeText notice={notice} />}
      </span>
      {canSwitch && conversationId && !switched && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="shrink-0"
          disabled={saving}
          onClick={() => void switchNow()}
        >
          {saving && <Loader2 className="animate-spin" aria-hidden />}
          {t('switchButton')}
        </Button>
      )}
    </div>
  );
}
