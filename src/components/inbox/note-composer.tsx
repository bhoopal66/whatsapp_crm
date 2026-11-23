'use client';

// ============================================================
// The composer's Note mode (migration 241): a team note inside the
// chat, never sent to the customer. Text only, on purpose: no
// attachments, templates or AI. Enter saves, Shift+Enter breaks a line,
// "@" offers the people who can see this chat.
// ============================================================

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, SendHorizontal, StickyNote } from 'lucide-react';
import { toast } from 'sonner';

import {
  activeMentionToken,
  canSaveNote,
  filterMentionCandidates,
  insertMention,
  mentionedIds,
  NOTE_MAX_LENGTH,
  type MentionCandidate,
} from '@/lib/inbox/notes';
import { noteDrafts } from '@/lib/inbox/note-drafts';
import { useAuth } from '@/hooks/use-auth';
import { isImeKey } from '@/lib/keyboard/ime';
import { cn } from '@/lib/utils';
import { fetchMentionCandidates } from './use-conversation-notes';

export function NoteComposer({
  conversationId,
  onSave,
  active = true,
}: {
  conversationId: string;
  /** False while hidden behind Reply mode: no candidate read, no focus. */
  active?: boolean;
  /** Saves the note; false when it was refused or failed. */
  onSave: (body: string, mentionIds: string[]) => Promise<boolean>;
}) {
  const t = useTranslations('ChatNotes');
  const listId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // A note left half-written here comes back (lib/inbox/note-drafts).
  // The thread keys this per login and chat, so reading once is enough.
  const userId = useAuth().user?.id ?? null;
  const [parked] = useState(() => noteDrafts.read(userId, conversationId));
  const [text, setText] = useState(parked?.text ?? '');
  const [caret, setCaret] = useState(text.length);
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<MentionCandidate[]>(
    parked?.picked ?? []
  );
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [candidates, setCandidates] = useState<{
    conversationId: string;
    list: MentionCandidate[];
  } | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void fetchMentionCandidates(conversationId).then((list) => {
      if (!cancelled) setCandidates({ conversationId, list });
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId, active]);

  useEffect(() => {
    noteDrafts.write(userId, conversationId, { text, picked });
  }, [userId, conversationId, text, picked]);

  useEffect(() => {
    if (active) textareaRef.current?.focus();
  }, [active]);

  // Grow with the text, up to the box's max height.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    // `active`: a restored note is measured when the box first shows;
    // hidden, it has no height.
  }, [text, active]);

  const token = activeMentionToken(text, caret);
  const matches = useMemo(
    () =>
      token && candidates?.conversationId === conversationId
        ? filterMentionCandidates(candidates.list, token.query)
        : [],
    [token, candidates, conversationId]
  );
  const listOpen =
    !!token && matches.length > 0 && dismissedAt !== token.start && !saving;
  const tooLong = text.length > NOTE_MAX_LENGTH;

  const pick = (c: MentionCandidate) => {
    if (!token) return;
    const next = insertMention(text, token, c.full_name);
    setText(next.text);
    setCaret(next.caret);
    setPicked((p) => (p.some((x) => x.user_id === c.user_id) ? p : [...p, c]));
    setHighlight(0);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const save = async () => {
    if (saving || !canSaveNote(text)) return;
    setSaving(true);
    // Out of the parked notes while it saves: coming back to the chat
    // meanwhile must not offer a note that is already saved.
    noteDrafts.clear(userId, conversationId);
    const ok = await onSave(text, mentionedIds(text, picked));
    setSaving(false);
    if (!ok) {
      noteDrafts.restore(userId, conversationId, { text, picked });
      toast.error(t('saveFailed'));
      return;
    }
    setText('');
    setCaret(0);
    setPicked([]);
    textareaRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeKey(e.nativeEvent)) return;
    if (listOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setHighlight((h) => (h + step + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(matches[Math.min(highlight, matches.length - 1)]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedAt(token!.start);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void save();
    }
  };

  return (
    <div className="relative">
      {listOpen && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('mentionListLabel')}
          className="border-border bg-popover absolute inset-x-0 bottom-full z-20 mb-1 max-h-56 overflow-y-auto rounded-lg border py-1 shadow-md"
        >
          {matches.map((c, i) => (
            <li
              key={c.user_id}
              role="option"
              aria-selected={i === highlight}
              className={cn(
                'text-popover-foreground cursor-pointer px-3 py-2 text-sm',
                i === highlight && 'bg-accent'
              )}
              onMouseDown={(e) => {
                // Keep the textarea's focus and caret.
                e.preventDefault();
                pick(c);
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              @{c.full_name}
            </li>
          ))}
        </ul>
      )}
      <div className="border-warning/40 bg-warning-soft rounded-lg border">
        <div className="text-warning flex items-center gap-1.5 px-3 pt-2 text-xs font-medium">
          <StickyNote className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{t('label')}</span>
        </div>
        <div className="flex items-end gap-1">
          <textarea
            ref={textareaRef}
            value={text}
            readOnly={saving}
            rows={1}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              setHighlight(0);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            aria-label={t('label')}
            aria-autocomplete="list"
            aria-controls={listOpen ? listId : undefined}
            aria-invalid={tooLong || undefined}
            placeholder={t('placeholder')}
            dir="auto"
            className="text-foreground placeholder:text-muted-foreground max-h-40 min-h-10 min-w-0 flex-1 resize-none border-0 bg-transparent px-3 py-2 text-base leading-5 outline-none sm:text-[15px]"
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !canSaveNote(text)}
            aria-label={t('save')}
            title={t('save')}
            className="text-warning hover:bg-warning-soft m-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? (
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
            ) : (
              <SendHorizontal className="h-5 w-5 rtl:rotate-180" aria-hidden />
            )}
          </button>
        </div>
        {tooLong && (
          <p className="text-destructive px-3 pb-2 text-xs" role="alert">
            {t('tooLong', { max: NOTE_MAX_LENGTH })}
          </p>
        )}
      </div>
    </div>
  );
}
