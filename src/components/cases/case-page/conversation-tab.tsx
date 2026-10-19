'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Eye, Loader2, Lock, Send } from 'lucide-react';
import { toast } from 'sonner';

import { MessageList } from '@/components/submission-groups/message-list';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { CaseTabProps } from '@/lib/cases/case-page';
import {
  parseConversation,
  sendResultMessageKey,
  shouldRestoreText,
  type CaseConversation,
} from '@/lib/cases/case-tabs';
import { shouldSendOnKey } from '@/lib/groups/group-page';
import { SEND_TEXT_MAX } from '@/lib/submission-groups/ui';

import { sendCaseRequest } from './case-dialogs';

type State = 'gated' | 'loading' | 'ok' | 'notReadable' | 'error';

/**
 * Conversation: the case's WhatsApp group. Opening it is an audited read
 * for supervisors, so nothing is fetched until the reader asks. An ended
 * group is read-only; an active one gets a composer for case writers.
 */
export function ConversationTab({ caseId, detail }: CaseTabProps) {
  const t = useTranslations('CasePage');
  const [state, setState] = useState<State>('gated');
  const [convo, setConvo] = useState<CaseConversation | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setState('loading');
      try {
        const res = await fetch(`/api/cases/${caseId}/conversation`, {
          cache: 'no-store',
        });
        const json: unknown = await res.json().catch(() => null);
        if (res.ok) {
          setConvo(parseConversation(json));
          setState('ok');
        } else if (
          res.status === 404 &&
          (json as { code?: unknown } | null)?.code === 'NOT_READABLE'
        ) {
          setState('notReadable');
        } else if (!quiet) setState('error');
      } catch {
        if (!quiet) setState('error');
      }
    },
    [caseId]
  );

  // Newest at the bottom: follow it whenever the list changes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [convo]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setText('');
    const res = await sendCaseRequest(
      `/api/cases/${caseId}/conversation`,
      'POST',
      { text: body }
    );
    const key = sendResultMessageKey(
      res.status,
      (res.json as { code?: unknown } | null)?.code
    );
    if (key === 'sent') toast.success(t('conversation.send.sent'));
    else if (key === 'sentNotRecorded')
      toast.warning(t('conversation.send.sentNotRecorded'));
    else {
      toast.error(t(`conversation.send.${key}`));
      if (shouldRestoreText(res.status)) setText(body);
    }
    setSending(false);
    await load(true);
  };

  if (state === 'gated' || state === 'loading')
    return (
      <div className="bg-card mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border p-6 text-center">
        <Lock className="text-muted-foreground size-6" aria-hidden />
        <p className="text-sm">{t('conversation.gateBody')}</p>
        <p className="text-muted-foreground text-xs">
          {t('conversation.auditNote')}
        </p>
        <Button disabled={state === 'loading'} onClick={() => void load()}>
          {state === 'loading' ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Eye className="size-4" aria-hidden />
          )}
          {t('conversation.show')}
        </Button>
      </div>
    );

  if (state === 'notReadable' || state === 'error')
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center text-sm">
        <p
          className={
            state === 'error' ? 'text-destructive' : 'text-muted-foreground'
          }
        >
          {t(
            state === 'error'
              ? 'conversation.loadFailed'
              : 'conversation.notReadable'
          )}
        </p>
        {state === 'error' && (
          <Button variant="outline" onClick={() => void load()}>
            {t('retry')}
          </Button>
        )}
      </div>
    );

  const messages = convo?.messages ?? [];
  const archived = convo?.archived ?? false;
  const noGroup = !convo?.groupId;

  return (
    <div className="bg-card flex h-[min(70vh,40rem)] min-h-80 flex-col rounded-lg border">
      {archived && (
        <p className="text-muted-foreground border-b px-3 py-2 text-xs">
          {t('conversation.archived')}
        </p>
      )}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
      >
        {messages.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {t(noGroup ? 'conversation.noGroup' : 'conversation.empty')}
          </p>
        ) : (
          <MessageList messages={messages} />
        )}
      </div>

      {!archived && !noGroup && (
        <div className="border-t p-2">
          {detail.permissions.canWrite ? (
            <div className="flex items-end gap-2">
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (shouldSendOnKey(e.nativeEvent)) {
                    e.preventDefault();
                    void send();
                  }
                }}
                disabled={sending}
                rows={1}
                maxLength={SEND_TEXT_MAX}
                placeholder={t('conversation.placeholder')}
                aria-label={t('conversation.placeholder')}
                className="max-h-32 min-h-9 resize-none"
              />
              <Button
                size="icon"
                aria-label={t('conversation.send.button')}
                disabled={sending || !text.trim()}
                onClick={() => void send()}
              >
                {sending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground px-1 text-xs">
              {t('conversation.cannotSend')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
