'use client';

import { Copy } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import {
  editedByOther,
  INITIAL_NOTES,
  isDirty,
  isOverLimit,
  NOTES_COUNTER_FROM,
  NOTES_MAX_CHARS,
  NOTES_POLL_MS,
  notesReducer,
  notesStatus,
  parseNotes,
  saveAnswer,
  saveDelay,
  shouldSave,
  type NotesEvent,
  type NotesState,
} from '@/lib/meetings/room-ui/notes';
import { keptKey, keptNotes as kept } from '@/lib/meetings/room-ui/kept';
import { cn } from '@/lib/utils';

import { useWorkspaceMembers } from '../use-workspace-members';
import { ConfirmDialog } from './confirm-dialog';

const notesUrl = (meetingId: string) => `/api/meetings/${meetingId}/notes`;

/**
 * Whether the tab belongs: false once a first read says the database has
 * no notes yet (migration 176). A failed read says nothing.
 */
export function useNotesAvailable(meetingId: string | null): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!meetingId) return;
    let live = true;
    fetch(notesUrl(meetingId))
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { available?: unknown } | null) => {
        if (live && typeof json?.available === 'boolean') {
          setAvailable(json.available);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [meetingId]);
  return available;
}

/** Shared minutes: autosaved, and never overwritten without being asked. */
export function RoomNotesPanel({
  meetingId,
  onClose,
}: {
  meetingId: string;
  onClose: () => void;
}) {
  const t = useTranslations('MeetingRoom.panels.notes');
  const format = useFormatter();
  const { nameOf } = useWorkspaceMembers();
  const { user } = useAuth();
  const selfId = user?.id ?? null;
  // `kept` (room-ui/kept.ts) holds what an unmounted panel leaves behind.
  const key = keptKey(selfId, meetingId);
  const url = notesUrl(meetingId);

  const [state, setState] = useState<NotesState>(() => {
    const left = kept.get(key);
    return left ? { ...left, loaded: false } : INITIAL_NOTES;
  });
  const [now, setNow] = useState(() => Date.now());
  const [confirming, setConfirming] = useState(false);
  // The truth between renders: a save's answer can land after unmount.
  const latest = useRef(state);
  const mounted = useRef(false);

  const apply = useCallback(
    (e: NotesEvent) => {
      const next = notesReducer(latest.current, e);
      latest.current = next;
      kept.set(key, next);
      setState(next);
    },
    [key]
  );

  const save = useCallback(
    async function run(keepalive = false): Promise<void> {
      const s = latest.current;
      if (!shouldSave(s)) return;
      apply({ type: 'saveStarted' });
      try {
        const res = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: s.text,
            expectedVersion: s.base.version,
          }),
          keepalive,
        });
        apply(saveAnswer(res.status, await res.json().catch(() => null)));
      } catch {
        apply({ type: 'saveFailed' });
      }
      // Typed during that save, then closed: no timer is left to send it.
      if (!mounted.current) await run(true);
    },
    [apply, url]
  );

  useEffect(() => {
    if (!shouldSave(state)) return;
    const id = setTimeout(() => void save(), saveDelay(state));
    return () => clearTimeout(id);
  }, [state, save]);

  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const json = (await res.json()) as { notes?: unknown };
        if (!live) return;
        apply({ type: 'polled', doc: parseNotes(json.notes) });
        setNow(Date.now());
      } catch {
        // The next tick reads again.
      }
    };
    void read();
    const id = setInterval(() => void read(), NOTES_POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [url, apply]);

  useEffect(() => {
    mounted.current = true;
    const flush = () => void save(true);
    window.addEventListener('pagehide', flush);
    return () => {
      mounted.current = false;
      window.removeEventListener('pagehide', flush);
      flush();
      const s = latest.current;
      if (!isDirty(s) && s.sending === null) kept.delete(key);
    };
  }, [save, key]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(latest.current.text);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  const nameFor = (userId: string | null) =>
    (userId && nameOf(userId)) || t('someone');

  const status = notesStatus(state);
  const edited = editedByOther(state, selfId);
  const statusText =
    status === 'idle'
      ? null
      : status === 'saved' && edited
        ? t('editedBy', {
            name: nameFor(edited.userId),
            when: format.relativeTime(new Date(edited.at), new Date(now)),
          })
        : t(status);
  const counter = state.text.length >= NOTES_MAX_CHARS - NOTES_COUNTER_FROM;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {state.conflict && (
        <div
          role="status"
          className="bg-card-2 mx-3 mb-2 rounded-xl p-3 text-sm"
          data-notes-conflict
        >
          <p className="font-medium">
            {t('updatedBy', { name: nameFor(state.conflict.updatedBy) })}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setConfirming(true)}
            >
              {t('seeTheirs')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                apply({ type: 'keepMine' });
                void save();
              }}
            >
              {t('keepMine')}
            </Button>
          </div>
        </div>
      )}
      <textarea
        value={state.text}
        onChange={(e) => apply({ type: 'typed', text: e.target.value })}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        readOnly={!state.loaded || state.closed}
        placeholder={t('placeholder')}
        aria-label={t('title')}
        aria-invalid={isOverLimit(state) || undefined}
        className="placeholder:text-muted-foreground/70 min-h-0 flex-1 resize-none bg-transparent px-4 py-2 text-sm leading-6 outline-none"
      />
      <div className="flex min-h-11 items-center gap-2 border-t px-4 py-1.5">
        <p
          className={cn(
            'text-muted-foreground min-w-0 flex-1 text-xs',
            (status === 'retrying' || status === 'tooLong') &&
              'text-destructive'
          )}
          aria-live="polite"
          data-notes-status
        >
          {statusText}
        </p>
        {counter && (
          <span
            className={cn(
              'shrink-0 text-xs tabular-nums',
              isOverLimit(state) ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {t('counter', { count: state.text.length, max: NOTES_MAX_CHARS })}
          </span>
        )}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={!state.text}
          onClick={() => void copy()}
          aria-label={t('copy')}
          title={t('copy')}
        >
          <Copy />
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('confirmTitle')}
        description={t('confirmBody')}
        confirmLabel={t('confirmAction')}
        destructive
        onConfirm={() => apply({ type: 'seeTheirs' })}
      />
    </div>
  );
}
