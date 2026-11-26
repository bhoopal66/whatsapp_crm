'use client';

// ============================================================
// A team note in the thread (migration 241): "Note · only your team
// sees this", its author and time, the text with the people it rang
// marked. Its author may edit it in place or delete it (with a
// confirm); the database refuses anyone else either way.
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Loader2,
  MoreVertical,
  Pencil,
  StickyNote,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import {
  canSaveNote,
  NOTE_MAX_LENGTH,
  splitNoteMentions,
  type ConversationNote,
} from '@/lib/inbox/notes';
import { noteDrafts, noteEditKey } from '@/lib/inbox/note-drafts';
import { isImeKey } from '@/lib/keyboard/ime';
import { cn } from '@/lib/utils';

export function ThreadNote({
  note,
  authorName,
  isMine,
  canManage,
  nameOf,
  onEdit,
  onDelete,
}: {
  note: ConversationNote;
  authorName: string | null;
  isMine: boolean;
  /** The viewer may write notes; with isMine, offers Edit and Delete. */
  canManage: boolean;
  /** A teammate's display name, to mark the people the note rang. */
  nameOf: (userId: string) => string | null;
  onEdit: (id: string, body: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const t = useTranslations('ChatNotes');
  // An edit left half-written comes back (lib/inbox/note-drafts), also
  // after Escape; Save and Cancel end it. Only its author has one.
  const draftKey = noteEditKey(note.id);
  const readParked = () =>
    isMine ? noteDrafts.read(note.author_id, draftKey) : null;
  const [parked] = useState(readParked);
  const [editing, setEditing] = useState(parked !== null);
  const [focusEdit, setFocusEdit] = useState(false);
  const [draft, setDraft] = useState(parked?.text ?? note.body);
  // What the edit started from: the note can change on another device.
  const [base, setBase] = useState(parked?.base ?? note.body);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const time = new Date(note.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const who = isMine ? t('you') : authorName || t('someone');
  const names = note.mention_ids
    .map((id) => nameOf(id))
    .filter((n): n is string => !!n);

  const typeEdit = (text: string) => {
    setDraft(text);
    if (text === note.body) noteDrafts.clear(note.author_id, draftKey);
    else noteDrafts.write(note.author_id, draftKey, { text, picked: [], base });
  };

  const cancelEdit = () => {
    noteDrafts.clear(note.author_id, draftKey);
    setEditing(false);
  };

  const saveEdit = async () => {
    if (busy || !canSaveNote(draft)) return;
    if (draft === note.body) {
      cancelEdit();
      return;
    }
    setBusy(true);
    // Out of the parked edits while it saves, back if it was not saved.
    noteDrafts.clear(note.author_id, draftKey);
    const ok = await onEdit(note.id, draft);
    setBusy(false);
    if (!ok) {
      noteDrafts.restore(note.author_id, draftKey, {
        text: draft,
        picked: [],
        base,
      });
      toast.error(t('editFailed'));
      return;
    }
    setEditing(false);
  };

  const confirmDelete = async () => {
    setConfirming(false);
    setBusy(true);
    const ok = await onDelete(note.id);
    setBusy(false);
    if (!ok) toast.error(t('deleteFailed'));
    else noteDrafts.clear(note.author_id, draftKey);
  };

  return (
    <div className="my-2 flex justify-center px-1" role="note">
      <div className="border-warning/40 bg-warning-soft w-full max-w-[min(36rem,92%)] rounded-lg border px-3 py-2 shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">
        <div className="flex items-start gap-2">
          <div className="text-warning flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 text-xs font-medium">
            <StickyNote className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{t('label')}</span>
            <span className="text-muted-foreground font-normal">
              · {who} · {time}
              {note.edited_at ? ` · ${t('edited')}` : ''}
            </span>
          </div>
          {isMine && canManage && !editing && (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t('actions')}
                disabled={busy}
                className="text-muted-foreground hover:bg-warning-soft -me-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <MoreVertical className="h-4 w-4" aria-hidden />
                )}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-36">
                <DropdownMenuItem
                  className="gap-2"
                  onClick={() => {
                    const kept = readParked();
                    setDraft(kept?.text ?? note.body);
                    setBase(kept?.base ?? note.body);
                    setFocusEdit(true);
                    setEditing(true);
                  }}
                >
                  <Pencil className="h-4 w-4" aria-hidden />
                  {t('edit')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  className="gap-2"
                  onClick={() => setConfirming(true)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                  {t('delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {editing ? (
          <div className="mt-1.5 space-y-2">
            <Textarea
              value={draft}
              readOnly={busy}
              onChange={(e) => typeEdit(e.target.value)}
              onKeyDown={(e) => {
                if (isImeKey(e.nativeEvent)) return;
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void saveEdit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  // Put away, not given up: Edit brings it back.
                  setEditing(false);
                }
              }}
              aria-label={t('edit')}
              aria-invalid={draft.length > NOTE_MAX_LENGTH || undefined}
              dir="auto"
              // Not one that came back by itself: the reply box has it.
              autoFocus={focusEdit}
              className="min-h-16 text-sm"
            />
            {/* Not while saving: the own save may arrive before its answer. */}
            {!busy && base !== note.body && (
              <p className="text-warning text-xs" role="alert">
                {t('changedMeanwhile', { body: note.body })}
              </p>
            )}
            {draft.length > NOTE_MAX_LENGTH && (
              <p className="text-destructive text-xs" role="alert">
                {t('tooLong', { max: NOTE_MAX_LENGTH })}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={cancelEdit}
              >
                {t('cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy || !canSaveNote(draft)}
                onClick={() => void saveEdit()}
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('saveEdit')}
              </Button>
            </div>
          </div>
        ) : (
          <p
            dir="auto"
            className="text-foreground mt-1 text-sm break-words whitespace-pre-wrap"
          >
            {splitNoteMentions(note.body, names).map((s, i) =>
              s.mention ? (
                <span key={i} className={cn('text-info rounded font-medium')}>
                  {s.text}
                </span>
              ) : (
                <span key={i}>{s.text}</span>
              )
            )}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('deleteTitle')}
        description={t('deleteBody')}
        cancelLabel={t('cancel')}
        confirmLabel={t('deleteConfirm')}
        onConfirm={() => void confirmDelete()}
        destructive
      />
    </div>
  );
}
