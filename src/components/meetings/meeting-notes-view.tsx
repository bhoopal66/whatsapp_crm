'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, Pencil, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { copyWithToast } from '@/components/context-menu/app-context-menu';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  NO_NOTES,
  notesSaveOutcome,
  notesTooLong,
  parseNotesRead,
  type MeetingNotes,
} from '@/lib/meetings/summary';

type Read =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'hidden' }
  | { kind: 'ready'; notes: MeetingNotes };

interface Edit {
  draft: string;
  /** The version the draft is based on, whatever a re-read brings in. */
  version: number;
  saving: boolean;
  /** Someone saved first: their notes. */
  conflict: MeetingNotes | null;
  error: 'closed' | 'tooLong' | 'failed' | null;
}

/** The minutes: read-only with Copy; a manager also edits them here. */
export function MeetingNotesView({
  meetingId,
  status,
  canEdit,
  nameFor,
  timeOf,
}: {
  meetingId: string;
  /** A change of status reads the notes again. */
  status: string;
  canEdit: boolean;
  nameFor: (userId: string) => string;
  timeOf: (iso: string) => string;
}) {
  const td = useTranslations('Meetings.detail');
  const tm = useTranslations('Meetings');
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [edit, setEdit] = useState<Edit | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/meetings/${meetingId}/notes`)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const parsed = parseNotesRead(await r.json());
        if (!parsed) throw new Error('shape');
        if (cancelled) return;
        setRead(
          parsed.available
            ? { kind: 'ready', notes: parsed.notes }
            : { kind: 'hidden' }
        );
      })
      .catch(() => {
        // Keep the notes already shown through a failed re-read.
        if (!cancelled)
          setRead((s) => (s.kind === 'ready' ? s : { kind: 'failed' }));
      });
    return () => {
      cancelled = true;
    };
  }, [meetingId, status, attempt]);

  if (read.kind === 'loading' || read.kind === 'hidden') return null;

  const heading = <h2 className="font-semibold">{td('notes')}</h2>;
  const card = 'bg-card space-y-3 rounded-xl border p-4 md:p-6';

  if (read.kind === 'failed') {
    return (
      <section className={card}>
        {heading}
        <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
          {td('notesFailed')}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAttempt((n) => n + 1)}
          >
            <RefreshCw className="size-4" aria-hidden />
            {td('retry')}
          </Button>
        </p>
      </section>
    );
  }

  const { notes } = read;
  if (!notes.body && !canEdit) return null;

  const save = async (current: Edit, version: number) => {
    setEdit({ ...current, version, saving: true, error: null });
    let outcome = notesSaveOutcome(0, null, current.draft);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/notes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: current.draft, expectedVersion: version }),
      });
      const json: unknown = await res.json().catch(() => null);
      outcome = notesSaveOutcome(res.status, json, current.draft);
    } catch {
      // Stays 'failed': the typed text is kept below.
    }
    if (outcome.kind === 'saved') {
      setRead({ kind: 'ready', notes: outcome.notes });
      setEdit(null);
      toast.success(td('notesSaved'));
    } else if (outcome.kind === 'stale') {
      const { latest } = outcome;
      setEdit({
        ...current,
        version,
        saving: false,
        conflict: latest,
        error: null,
      });
    } else {
      setEdit({ ...current, version, saving: false, error: outcome.kind });
    }
  };

  if (edit) {
    const { conflict } = edit;
    const tooLong = notesTooLong(edit.draft);
    const errorKey =
      edit.error === 'closed'
        ? 'notesClosed'
        : edit.error === 'failed'
          ? 'notesSaveFailed'
          : null;
    return (
      <section className={card}>
        {heading}
        {conflict && (
          <div className="bg-warning-soft space-y-2 rounded-lg p-3 text-sm">
            <p className="font-medium">
              {td('notesConflict', {
                name: conflict.updatedBy
                  ? nameFor(conflict.updatedBy)
                  : tm('unknownPerson'),
                time: conflict.updatedAt ? timeOf(conflict.updatedAt) : '',
              })}
            </p>
            <p className="bg-card-2 max-h-40 overflow-y-auto rounded-md p-2 break-words whitespace-pre-wrap">
              {conflict.body}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={edit.saving}
                onClick={() =>
                  setEdit({
                    ...edit,
                    draft: conflict.body,
                    version: conflict.version,
                    conflict: null,
                  })
                }
              >
                {td('notesUseLatest')}
              </Button>
              <Button
                size="sm"
                disabled={edit.saving || tooLong}
                onClick={() =>
                  void save({ ...edit, conflict: null }, conflict.version)
                }
              >
                {td('notesSaveMine')}
              </Button>
            </div>
          </div>
        )}
        <Textarea
          value={edit.draft}
          onChange={(e) => setEdit({ ...edit, draft: e.target.value })}
          aria-label={td('notes')}
          rows={10}
          autoFocus
        />
        {(tooLong || edit.error === 'tooLong') && (
          <p role="alert" className="text-destructive text-sm">
            {td('notesTooLong')}
          </p>
        )}
        {errorKey && (
          <p role="alert" className="text-destructive text-sm">
            {td(errorKey)}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {!conflict && (
            <Button
              disabled={edit.saving || tooLong}
              onClick={() => void save(edit, edit.version)}
            >
              {td('notesSave')}
            </Button>
          )}
          <Button
            variant="outline"
            disabled={edit.saving}
            onClick={() => setEdit(null)}
          >
            {td('notesCancel')}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {heading}
        <div className="flex gap-2">
          {notes.body && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void copyWithToast(notes.body, {
                  copied: td('notesCopied'),
                  failed: td('notesCopyFailed'),
                })
              }
            >
              <Copy className="size-4" aria-hidden />
              {td('notesCopy')}
            </Button>
          )}
          {canEdit && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setEdit({
                  draft: notes.body,
                  version: notes.version,
                  saving: false,
                  conflict: null,
                  error: null,
                })
              }
            >
              <Pencil className="size-4" aria-hidden />
              {notes.body ? td('edit') : td('notesAdd')}
            </Button>
          )}
        </div>
      </div>
      {notes.body ? (
        <>
          <p className="text-sm break-words whitespace-pre-wrap">
            {notes.body}
          </p>
          {notes.updatedAt && notes !== NO_NOTES && (
            <p className="text-muted-foreground text-xs">
              {td('notesUpdated', {
                name: notes.updatedBy
                  ? nameFor(notes.updatedBy)
                  : tm('unknownPerson'),
                time: timeOf(notes.updatedAt),
              })}
            </p>
          )}
        </>
      ) : (
        <p className="text-muted-foreground text-sm">{td('notesEmpty')}</p>
      )}
    </section>
  );
}
