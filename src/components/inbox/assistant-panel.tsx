'use client';

// ============================================================
// The chat's Assistant panel (migration 323, docs/ai-agent.md).
//
// A button in the chat header's actions opens a side sheet (full width
// on a phone). It is shown to agents and up while the workspace has the
// assistant on, and to owners and admins always, so they can switch it
// on from here. The panel:
//   - summarises the chat, answers a question about it;
//   - drafts a reply and hands it to the composer (`onUseDraft`): the
//     person edits and sends it themselves. Nothing here sends;
//   - suggests actions as cards. A card changes nothing until the person
//     confirms it (lib/chat-assist/client.ts: the pending action is
//     confirmed, then run through the guarded router); Dismiss denies it.
// Cards left open when the panel closes or the chat changes are denied,
// so they do not hold the person's five open pending slots.
// ============================================================

import {
  Brain,
  Check,
  ClipboardList,
  FileText,
  Loader2,
  MessageSquareText,
  NotebookPen,
  PencilLine,
  Send,
  Sparkles,
  Tag,
  UserPlus,
  X,
} from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  cardErrorKey,
  confirmCard,
  dismissCard,
  type PendingCard,
} from '@/lib/chat-assist/client';
import type { ActionCard } from '@/lib/chat-assist/router';
import { CHAT_ASSIST_QUESTION_MAX } from '@/lib/chat-assist/prompt';
import { cn } from '@/lib/utils';

/** Round icon button in the thread header (as `thread-header.tsx`). */
const HEADER_ICON_BUTTON =
  'text-wa-icon hover:bg-wa-icon-hover inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors';

interface Settings {
  enabled: boolean;
  canUse: boolean;
  canToggle: boolean;
}

type Result =
  | { kind: 'text'; title: 'summary' | 'answer'; text: string }
  | { kind: 'draft'; text: string }
  | {
      kind: 'cards';
      cards: (ActionCard & { done?: 'confirmed' | 'dismissed' })[];
    };

type Busy = null | 'summary' | 'draft' | 'ask' | 'suggest' | 'toggle';

export function AssistantPanelButton({
  conversationId,
  onUseDraft,
}: {
  conversationId: string;
  /** Puts the draft into this chat's reply box; never sends. */
  onUseDraft: (conversationId: string, text: string) => void;
}) {
  const t = useTranslations('ChatAssist');
  const locale = useLocale();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [cardBusy, setCardBusy] = useState<string | null>(null);
  // The chat each answer belongs to: one landing after a switch is dropped.
  const chatRef = useRef(conversationId);
  const resultRef = useRef<Result | null>(null);
  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/assist/chat/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Settings | null) => {
        if (!cancelled && s) setSettings(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** Deny every card still open, so none keeps a pending slot. */
  const releaseCards = useCallback(() => {
    const r = resultRef.current;
    if (r?.kind !== 'cards') return;
    for (const c of r.cards)
      if (c.status === 'pending' && !c.done) void dismissCard(c);
  }, []);

  // A new chat starts clean; cards of the last one are released.
  useEffect(() => {
    chatRef.current = conversationId;
    return () => {
      releaseCards();
      setResult(null);
      setError(null);
      setQuestion('');
      setBusy(null);
    };
  }, [conversationId, releaseCards]);

  const onOpenChange = (next: boolean) => {
    if (!next) {
      releaseCards();
      setResult((r) => (r?.kind === 'cards' ? null : r));
    }
    setOpen(next);
  };

  if (!settings) return null;
  const usable = settings.enabled && settings.canUse;
  if (!usable && !settings.canToggle) return null;

  const ask = async (task: Exclude<Busy, null | 'toggle'>) => {
    if (busy) return;
    const chat = conversationId;
    releaseCards();
    setBusy(task);
    setError(null);
    try {
      const res = await fetch(`/api/assist/chat/${chat}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task,
          locale,
          ...(task === 'ask' ? { question } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (chatRef.current !== chat) {
        // Another chat now: its cards were never shown, release them.
        if (Array.isArray(data.cards))
          for (const c of data.cards as ActionCard[])
            if (c.status === 'pending') void dismissCard(c);
        return;
      }
      if (!res.ok) {
        setResult(null);
        setError(
          data.code === 'chat_assist_off'
            ? t('errors.off')
            : data.code === 'ai_not_configured'
              ? t('errors.noAi')
              : data.code === 'no_messages'
                ? t('errors.noMessages')
                : res.status === 429
                  ? t('errors.busy')
                  : t('errors.failed')
        );
        return;
      }
      if (task === 'draft' && typeof data.draft === 'string')
        setResult({ kind: 'draft', text: data.draft.trim() });
      else if (task === 'suggest' && Array.isArray(data.cards))
        setResult({ kind: 'cards', cards: data.cards });
      else if (typeof data.text === 'string')
        setResult({
          kind: 'text',
          title: task === 'ask' ? 'answer' : 'summary',
          text: data.text.trim(),
        });
      else setError(t('errors.failed'));
    } catch {
      if (chatRef.current === chat) setError(t('errors.failed'));
    } finally {
      if (chatRef.current === chat) setBusy(null);
    }
  };

  const toggle = async (enabled: boolean) => {
    setBusy('toggle');
    try {
      const res = await fetch('/api/assist/chat/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(t('errors.toggle'));
        return;
      }
      setSettings((s) => (s ? { ...s, enabled: data.enabled === true } : s));
    } catch {
      toast.error(t('errors.toggle'));
    } finally {
      setBusy(null);
    }
  };

  const markCard = (pendingId: string, done: 'confirmed' | 'dismissed') =>
    setResult((r) =>
      r?.kind === 'cards'
        ? {
            ...r,
            cards: r.cards.map((c) =>
              c.status === 'pending' && c.pendingId === pendingId
                ? { ...c, done }
                : c
            ),
          }
        : r
    );

  const onConfirm = async (card: PendingCard) => {
    if (cardBusy) return;
    setCardBusy(card.pendingId);
    try {
      const out = await confirmCard(conversationId, card);
      if (out.ok) {
        markCard(card.pendingId, 'confirmed');
        toast.success(t('cardDone'));
      } else {
        // Refused at either step: the action is spent or never ran.
        markCard(card.pendingId, 'dismissed');
        toast.error(t(`cardErrors.${cardErrorKey(out.code)}`));
      }
    } finally {
      setCardBusy(null);
    }
  };

  const onDismiss = (card: PendingCard) => {
    markCard(card.pendingId, 'dismissed');
    void dismissCard(card);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        aria-label={t('open')}
        title={t('open')}
        className={cn(HEADER_ICON_BUTTON, open && 'bg-wa-icon-hover')}
      >
        <Sparkles className="h-4 w-4" />
      </button>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          <SheetHeader className="border-border border-b pe-12">
            <SheetTitle className="flex items-center gap-2">
              <Sparkles className="text-primary h-4 w-4" />
              {t('title')}
            </SheetTitle>
            <SheetDescription>{t('neverSends')}</SheetDescription>
          </SheetHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            {settings.canToggle && (
              <label className="bg-card-2 flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{t('switch.label')}</span>
                  <span className="text-muted-foreground block text-xs">
                    {t('switch.hint')}
                  </span>
                </span>
                <Switch
                  checked={settings.enabled}
                  disabled={busy === 'toggle'}
                  onCheckedChange={(v) => void toggle(v)}
                />
              </label>
            )}

            {!usable ? (
              <p className="text-muted-foreground text-sm">{t('offNotice')}</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <ActionButton
                    icon={FileText}
                    label={t('summarise')}
                    busy={busy === 'summary'}
                    disabled={!!busy}
                    onClick={() => void ask('summary')}
                  />
                  <ActionButton
                    icon={PencilLine}
                    label={t('draft')}
                    busy={busy === 'draft'}
                    disabled={!!busy}
                    onClick={() => void ask('draft')}
                  />
                  <ActionButton
                    icon={ClipboardList}
                    label={t('suggest')}
                    busy={busy === 'suggest'}
                    disabled={!!busy}
                    onClick={() => void ask('suggest')}
                    className="col-span-2"
                  />
                </div>

                <form
                  className="flex items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (question.trim()) void ask('ask');
                  }}
                >
                  <Textarea
                    value={question}
                    onChange={(e) =>
                      setQuestion(
                        e.target.value.slice(0, CHAT_ASSIST_QUESTION_MAX)
                      )
                    }
                    onKeyDown={(e) => {
                      if (
                        e.key === 'Enter' &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        if (question.trim()) void ask('ask');
                      }
                    }}
                    placeholder={t('askPlaceholder')}
                    aria-label={t('askLabel')}
                    rows={2}
                    dir="auto"
                    className="min-h-0 resize-none"
                  />
                  <Button
                    type="submit"
                    size="icon"
                    disabled={!!busy || !question.trim()}
                    aria-label={t('askSend')}
                  >
                    {busy === 'ask' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4 rtl:rotate-180" />
                    )}
                  </Button>
                </form>

                {error && (
                  <p className="bg-destructive-soft text-destructive rounded-lg px-3 py-2 text-sm">
                    {error}
                  </p>
                )}

                {result?.kind === 'text' && (
                  <section className="bg-card-2 rounded-lg p-3">
                    <h3 className="text-muted-foreground mb-1 text-xs font-medium">
                      {t(
                        result.title === 'answer'
                          ? 'answerTitle'
                          : 'summaryTitle'
                      )}
                    </h3>
                    <p
                      dir="auto"
                      className="text-start text-sm whitespace-pre-wrap"
                    >
                      {result.text}
                    </p>
                  </section>
                )}

                {result?.kind === 'draft' && (
                  <section className="bg-card-2 flex flex-col gap-2 rounded-lg p-3">
                    <h3 className="text-muted-foreground text-xs font-medium">
                      {t('draftTitle')}
                    </h3>
                    <p
                      dir="auto"
                      className="text-start text-sm whitespace-pre-wrap"
                    >
                      {result.text}
                    </p>
                    <Button
                      size="sm"
                      className="self-start"
                      onClick={() => {
                        onUseDraft(conversationId, result.text);
                        setOpen(false);
                      }}
                    >
                      <MessageSquareText className="me-1.5 h-4 w-4" />
                      {t('useDraft')}
                    </Button>
                  </section>
                )}

                {result?.kind === 'cards' && (
                  <section className="flex flex-col gap-2">
                    <h3 className="text-muted-foreground text-xs font-medium">
                      {t('cardsTitle')}
                    </h3>
                    {result.cards.length === 0 ? (
                      <p className="text-muted-foreground text-sm">
                        {t('noCards')}
                      </p>
                    ) : (
                      result.cards.map((c, i) => (
                        <SuggestionCard
                          key={c.status === 'pending' ? c.pendingId : `u${i}`}
                          card={c}
                          busy={
                            c.status === 'pending' && cardBusy === c.pendingId
                          }
                          onConfirm={onConfirm}
                          onDismiss={onDismiss}
                        />
                      ))
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function ActionButton({
  icon: Icon,
  label,
  busy,
  disabled,
  onClick,
  className,
}: {
  icon: typeof FileText;
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={onClick}
      className={cn('justify-start', className)}
    >
      {busy ? (
        <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
      ) : (
        <Icon className="me-1.5 h-4 w-4" />
      )}
      <span className="truncate">{label}</span>
    </Button>
  );
}

const CARD_ICON = {
  tag: Tag,
  task: ClipboardList,
  assign: UserPlus,
  note: NotebookPen,
  remember: Brain,
} as const;

function SuggestionCard({
  card,
  busy,
  onConfirm,
  onDismiss,
}: {
  card: ActionCard & { done?: 'confirmed' | 'dismissed' };
  busy: boolean;
  onConfirm: (c: PendingCard) => void;
  onDismiss: (c: PendingCard) => void;
}) {
  const t = useTranslations('ChatAssist');
  const format = useFormatter();
  const v = card.view;
  const Icon = CARD_ICON[v.kind];
  const title =
    v.kind === 'tag'
      ? t('cards.tag', {
          tag: v.subTagName ? `${v.tagName} › ${v.subTagName}` : v.tagName,
        })
      : v.kind === 'task'
        ? t('cards.task', { title: v.title })
        : v.kind === 'assign'
          ? t('cards.assign', { name: v.memberName })
          : v.kind === 'note'
            ? t('cards.note')
            : t('cards.remember');
  const done = card.status === 'pending' ? card.done : undefined;
  return (
    <div
      className={cn(
        'border-border bg-card rounded-lg border p-3 text-sm',
        done && 'opacity-60'
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className="text-primary mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p dir="auto" className="text-start font-medium break-words">
            {title}
          </p>
          {v.kind === 'note' && (
            <p dir="auto" className="mt-1 text-start whitespace-pre-wrap">
              {v.body}
            </p>
          )}
          {v.kind === 'remember' && (
            <p dir="auto" className="mt-1 text-start whitespace-pre-wrap">
              {v.text}
            </p>
          )}
          {v.kind === 'task' && v.dueAt && (
            <p className="text-muted-foreground mt-1 text-xs">
              {t('cards.due', {
                when: format.dateTime(new Date(v.dueAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })}
            </p>
          )}
          {card.why && (
            <p
              dir="auto"
              className="text-muted-foreground mt-1 text-start text-xs"
            >
              {card.why}
            </p>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        {card.status === 'unavailable' ? (
          <span className="text-muted-foreground text-xs">
            {t(`cardErrors.${cardErrorKey(card.reason)}`)}
          </span>
        ) : done ? (
          <span
            className={cn(
              'inline-flex items-center gap-1 text-xs',
              done === 'confirmed' ? 'text-success' : 'text-muted-foreground'
            )}
          >
            {done === 'confirmed' ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <X className="h-3.5 w-3.5" />
            )}
            {t(done === 'confirmed' ? 'cardDone' : 'cardDismissed')}
          </span>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onDismiss(card)}
            >
              {t('dismiss')}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => onConfirm(card)}>
              {busy ? (
                <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Check className="me-1.5 h-4 w-4" />
              )}
              {t('confirm')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
