'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Eye, Loader2, Lock, MessageSquareOff } from 'lucide-react';
import { toast } from 'sonner';

import {
  GroupComposer,
  type GroupMediaSendPayload,
} from '@/components/groups/group-composer';
import { MessageList } from '@/components/submission-groups/message-list';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { usePageVisible } from '@/hooks/use-page-visible';
import type { CaseTabProps } from '@/lib/cases/case-page';
import {
  composerDone,
  conversationView,
  parseConversation,
  sendResultMessageKey,
  type CaseConversation,
} from '@/lib/cases/case-tabs';
import {
  canRefresh,
  CONVERSATION_PROBE_MS,
  ConversationRefresh,
  mergeConversation,
  type ConversationAnswer,
} from '@/lib/cases/conversation-refresh';
import { bottomGap, isNearBottom } from '@/lib/inbox/thread-scroll';
import { ownSendStored } from '@/lib/submission-groups/ui';

import { sendCaseRequest } from './case-dialogs';

type State = 'gated' | 'loading' | 'ok' | 'notReadable' | 'error';

/**
 * Conversation: the case's WhatsApp group. Opening it is an audited read
 * for supervisors, so nothing is fetched until the reader asks. An ended
 * group is read-only; an active one gets the group composer (text, files,
 * voice notes) for case writers. A submission opened without a WhatsApp
 * group (136) gets neither. While it is open and on screen an active group
 * is asked for news, without an audit row, and read again when there is
 * some (`ConversationRefresh`).
 */
export function ConversationTab({ caseId, detail }: CaseTabProps) {
  const t = useTranslations('CasePage');
  const [state, setState] = useState<State>('gated');
  const [convo, setConvo] = useState<CaseConversation | null>(null);
  const userId = useAuth().user?.id ?? null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [refresh] = useState(() => new ConversationRefresh());
  // Found ended by a background read: the composer stays (it may hold
  // unsent text and files) until the person's next send.
  const [endedInView, setEndedInView] = useState(false);

  const read = useCallback(async (): Promise<ConversationAnswer> => {
    try {
      const res = await fetch(`/api/cases/${caseId}/conversation`, {
        cache: 'no-store',
      });
      const json: unknown = await res.json().catch(() => null);
      if (res.ok) return { kind: 'ok', convo: parseConversation(json) };
      if (
        res.status === 404 &&
        (json as { code?: unknown } | null)?.code === 'NOT_READABLE'
      )
        return { kind: 'notReadable' };
    } catch {
      /* failed */
    }
    return { kind: 'failed' };
  }, [caseId]);

  /** What was read, or null. */
  const load = useCallback(
    async (quiet = false): Promise<CaseConversation | null> => {
      if (!quiet) setState('loading');
      const mine = refresh.start();
      const answer = await read();
      if (answer.kind === 'failed') {
        if (!quiet) setState('error');
        return null;
      }
      const ok = answer.kind === 'ok';
      if (refresh.settle(mine, ok)) {
        if (ok) {
          setConvo(answer.convo);
          setEndedInView(false);
        }
        setState(ok ? 'ok' : 'notReadable');
      }
      return ok ? answer.convo : null;
    },
    [read, refresh]
  );

  // Newest at the bottom: follow it, unless the reader scrolled away.
  const shown = useRef(convo);
  useLayoutEffect(() => {
    shown.current = convo;
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [convo]);

  const visible = usePageVisible();
  const wasHidden = useRef(false);
  const refreshing = state === 'ok' && canRefresh(convo);
  useEffect(() => {
    if (!visible) {
      wasHidden.current = true;
      return;
    }
    const back = wasHidden.current;
    wasHidden.current = false;
    if (!refreshing) return;
    let active = true;
    const tick = () => {
      if (!shown.current) return;
      void refresh.tick({
        shown: shown.current,
        probe: async (since) => {
          const res = await fetch(
            `/api/cases/${caseId}/conversation?since=${encodeURIComponent(since)}`,
            { cache: 'no-store' }
          );
          const json = (await res.json()) as { changed?: unknown };
          return res.ok && json.changed === true;
        },
        read,
        active: () => active,
        show: (fresh) => {
          setConvo((prev) => (prev ? mergeConversation(prev, fresh) : fresh));
          if (fresh.archived) setEndedInView(true);
        },
      });
    };
    if (back) tick();
    const timer = setInterval(tick, CONVERSATION_PROBE_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [visible, refreshing, caseId, read, refresh]);

  /** Sends, and says how it went. False gives it back to the composer. */
  const post = async (
    payload: { text: string } | { media: GroupMediaSendPayload }
  ): Promise<boolean> => {
    const before = convo?.messages ?? [];
    const res = await sendCaseRequest(
      `/api/cases/${caseId}/conversation`,
      'POST',
      payload
    );
    const code = (res.json as { code?: unknown } | null)?.code;
    const key = sendResultMessageKey(res.status, code);
    if (key === 'sent') toast.success(t('conversation.send.sent'));
    else if (key === 'sentNotRecorded')
      toast.warning(t('conversation.send.sentNotRecorded'));
    else toast.error(t(`conversation.send.${key}`));
    atBottom.current = true;
    const now = await load(true);
    return composerDone({
      status: res.status,
      code,
      media: 'media' in payload,
      stored: now && ownSendStored(before, now.messages, userId),
    });
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

  // 136: a submission opened without a WhatsApp group has nothing to show
  // and nowhere to send; say why instead of an empty chat.
  if (convo && conversationView(convo) === 'noWhatsappGroup')
    return (
      <div className="bg-card mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border p-6 text-center">
        <MessageSquareOff
          className="text-muted-foreground size-6"
          aria-hidden
        />
        <p className="text-sm">{t('conversation.noWhatsappGroup')}</p>
        <p className="text-muted-foreground text-xs">
          {t('conversation.noWhatsappGroupHelp')}
        </p>
      </div>
    );

  const messages = convo?.messages ?? [];
  const archived = convo?.archived ?? false;
  const noGroup = !convo || conversationView(convo) === 'noGroup';

  return (
    <div className="bg-card flex h-[min(70vh,40rem)] min-h-80 flex-col overflow-hidden rounded-lg border">
      {archived && (
        <p className="text-muted-foreground border-b px-3 py-2 text-xs">
          {t('conversation.archived')}
        </p>
      )}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          atBottom.current = isNearBottom(bottomGap(e.currentTarget));
        }}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
      >
        {messages.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {t(noGroup ? 'conversation.noGroup' : 'conversation.empty')}
          </p>
        ) : (
          <>
            {convo?.truncated && convo.groupId && (
              <p className="text-muted-foreground text-center text-xs">
                {t.rich('conversation.olderNotShown', {
                  link: (chunks) => (
                    <Link
                      href={`/submission-groups/${convo.groupId}`}
                      className="text-primary underline"
                    >
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
            )}
            <MessageList messages={messages} />
          </>
        )}
      </div>

      {(!archived || endedInView) &&
        !noGroup &&
        (detail.permissions.canWrite ? (
          <GroupComposer
            chatKey={`case:${caseId}`}
            userId={userId}
            onSendText={(text) => post({ text })}
            onSendMedia={(media) => post({ media })}
            placeholder={t('conversation.placeholder')}
          />
        ) : (
          <p className="text-muted-foreground border-t p-3 text-xs">
            {t('conversation.cannotSend')}
          </p>
        ))}
    </div>
  );
}
