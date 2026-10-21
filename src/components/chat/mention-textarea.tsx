'use client';

import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AtSign } from 'lucide-react';

import { mentionQueryAt } from '@/lib/chat';
import {
  mentionCandidates,
  type ComposerDraft,
  type MentionCandidate,
} from '@/lib/chat/composer';
import {
  composerKeyAction,
  pickCandidate,
  wrapIndex,
} from '@/lib/chat/composer-input';
import { avatarTint, initialOf, roleLabelKey } from '@/lib/chat/view';
import { cn } from '@/lib/utils';

import { useChatWorkspaceContext } from './chat-context';

const MAX_HEIGHT_PX = 200;

export interface MentionTextareaProps {
  draft: ComposerDraft;
  onDraftChange: (draft: ComposerDraft) => void;
  /** Enter (never during an IME composition). */
  onSubmit: () => void;
  /** Esc with the mention list closed. */
  onCancel?: () => void;
  /** Offer @channel / @here. */
  broadcasts: boolean;
  ariaLabel: string;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}

/**
 * The auto-growing input of the composer and the inline editor: readable
 * "@Name" mentions picked from a popover (↑/↓, Enter/Tab, Esc). The
 * caller serializes the draft with serializeDraft when it sends.
 */
export function MentionTextarea(p: MentionTextareaProps) {
  const t = useTranslations('Chat');
  const tRole = useTranslations('Sidebar');
  const { people, userId } = useChatWorkspaceContext();
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const listId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState({ key: '', i: 0 });

  const text = p.draft.text;
  const query = caret === null ? null : mentionQueryAt(text, caret);
  const queryKey = query ? `${query.start}:${query.query}` : '';
  const others = useMemo(
    () =>
      people.filter((x) => x.userId.toLowerCase() !== userId?.toLowerCase()),
    [people, userId]
  );
  const candidates = useMemo<MentionCandidate[] | null>(
    () =>
      query && query.start !== dismissedAt
        ? mentionCandidates(others, query.query, { broadcasts: p.broadcasts })
        : null,
    // queryKey stands for `query`, a new object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryKey, dismissedAt, others, p.broadcasts]
  );
  const count = candidates?.length ?? 0;
  const activeIndex = wrapIndex(active.key === queryKey ? active.i : 0, count);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text]);

  const autoFocus = p.autoFocus;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!autoFocus || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

  const pick = (c: MentionCandidate) => {
    const r = pickCandidate(p.draft, caret ?? text.length, c);
    pendingCaret.current = r.caret;
    setCaret(r.caret);
    p.onDraftChange(r.draft);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const action = composerKeyAction(
      {
        key: e.key,
        shiftKey: e.shiftKey,
        // keyCode 229: Safari's Enter that ends a composition.
        composing: e.nativeEvent.isComposing || e.keyCode === 229,
      },
      count > 0
    );
    if (!action) return;
    e.preventDefault();
    if (action === 'next' || action === 'prev')
      setActive({
        key: queryKey,
        i: activeIndex + (action === 'next' ? 1 : -1),
      });
    else if (action === 'pick' && candidates) pick(candidates[activeIndex]);
    else if (action === 'close' || (action === 'cancel' && candidates))
      setDismissedAt(query?.start ?? null);
    else if (action === 'cancel') p.onCancel?.();
    else if (action === 'send') p.onSubmit();
  };

  return (
    <div className={cn('relative', p.className)}>
      {candidates && (
        <div
          id={listId}
          role="listbox"
          aria-label={t('composer.mentionList')}
          className="bg-popover text-popover-foreground absolute bottom-full left-0 z-20 mb-2 max-h-64 w-72 max-w-full overflow-y-auto rounded-lg border p-1 shadow-md"
        >
          {count === 0 && (
            <p className="text-muted-foreground px-2 py-1.5 text-sm">
              {t('composer.noMatches')}
            </p>
          )}
          {candidates.map((c, i) => {
            const roleKey =
              c.type === 'person' ? roleLabelKey(c.person.role) : null;
            return (
              <div
                key={c.type === 'person' ? c.person.userId : c.kind}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                // mousedown, not click: the textarea keeps focus and caret.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c);
                }}
                onMouseEnter={() => setActive({ key: queryKey, i })}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                  i === activeIndex && 'bg-accent text-accent-foreground'
                )}
              >
                {c.type === 'person' ? (
                  <>
                    <span
                      className={cn(
                        'flex size-6 shrink-0 items-center justify-center rounded text-xs font-bold',
                        avatarTint(c.person.userId)
                      )}
                    >
                      {initialOf(c.name)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {c.name}
                    </span>
                    {roleKey && (
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {tRole(roleKey)}
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <span className="bg-muted flex size-6 shrink-0 items-center justify-center rounded">
                      <AtSign className="size-3.5" aria-hidden />
                    </span>
                    <span className="font-medium">@{c.kind}</span>
                    <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                      {t(
                        c.kind === 'channel'
                          ? 'composer.mentionChannel'
                          : 'composer.mentionHere'
                      )}
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={text}
        aria-label={p.ariaLabel}
        aria-autocomplete="list"
        aria-controls={candidates ? listId : undefined}
        aria-activedescendant={
          count > 0 ? `${listId}-${activeIndex}` : undefined
        }
        placeholder={p.placeholder}
        onChange={(e) => {
          setCaret(e.target.selectionStart);
          p.onDraftChange({ text: e.target.value, picked: p.draft.picked });
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        className="placeholder:text-muted-foreground bg-background focus-visible:ring-ring/40 block w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-2"
      />
    </div>
  );
}
