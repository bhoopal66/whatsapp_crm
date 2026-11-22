'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  Loader2,
  Mic,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  UserRound,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { EmptyState } from '@/components/dashboard/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { canAddVoiceNotes } from '@/lib/auth/roles';
import {
  MAX_RECORDING_SECONDS,
  OPUS_ENCODER_PATH,
  SEND_BUTTON,
} from '@/lib/inbox/composer-ui';
import { cn } from '@/lib/utils';
import {
  DEFAULT_TTS_VOICE,
  ENTRY_TITLE_MAX,
  RTL_LANGUAGES,
  SCRIPT_MAX,
  SUBJECT_LABEL_MAX,
  TTS_VOICES,
  VOICE_LANGUAGES,
  VOICE_MAX_BYTES,
  isTtsVoice,
  type TtsVoice,
  type VoiceLanguage,
} from '@/lib/voice-library/constants';
import { scriptProblem } from '@/lib/voice-library/script';
import type {
  SubjectKey,
  VoiceEntryRow,
  VoiceLibraryPayload,
} from '@/lib/voice-library/types';
import {
  canDeleteEntry,
  entriesFor,
  firstLanguageWithEntries,
  languageCounts,
  subjectOptions,
  type SubjectOption,
} from '@/lib/voice-library/view';

import type { ComposerMenuItem } from './composer-more-menu';
import { VoiceNotePlayer } from './voice-note-player';
import { VoiceRecordingBar } from './voice-recording-bar';

/** What the composer sends: a voice note already in chat-media. */
export interface VoiceLibrarySend {
  mediaUrl: string;
  /**
   * Object path to delete if the send certainly failed: a personalised
   * note's staged copy. Empty for a library entry, which must outlive a
   * failed send (an empty path is never deleted).
   */
  path: string;
}

type Method = 'record' | 'tts';

/**
 * The composer's More-menu entry that opens the library. Disabled while
 * only templates may be sent (Meta's closed window): a voice note is a
 * free-form message.
 */
export function useVoiceLibraryMenuItem(
  onOpen: () => void,
  disabled: boolean
): ComposerMenuItem {
  const t = useTranslations('VoiceLibrary');
  return {
    id: 'voice-library',
    icon: AudioLines,
    label: t('menuLabel'),
    onSelect: onOpen,
    disabled,
  };
}

/**
 * The voice-note library, opened from the composer's More menu: pick a
 * subject and a language, play an entry, send it (as a voice message,
 * through the composer's ordinary media send), or add one by recording
 * or by AI speech from a script. Entries reach the whole workspace at
 * once; the author or an admin deletes.
 */
export function VoiceLibraryPicker({
  open,
  onOpenChange,
  conversationId,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  onSend: (note: VoiceLibrarySend) => void;
}) {
  const t = useTranslations('VoiceLibrary');
  const { user, accountRole } = useAuth();
  const canAdd = !!accountRole && canAddVoiceNotes(accountRole);

  const [library, setLibrary] = useState<VoiceLibraryPayload | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [tab, setTab] = useState<'send' | 'add'>('send');
  const [subject, setSubject] = useState<SubjectKey>('builtin:welcome');
  const [language, setLanguage] = useState<VoiceLanguage>('en');

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch('/api/voice-library', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setLibrary((await res.json()) as VoiceLibraryPayload);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const entries = useMemo(() => library?.entries ?? [], [library]);
  const subjects = useMemo(
    () => subjectOptions(library?.subjects ?? [], entries),
    [library, entries]
  );
  const counts = useMemo(
    () => languageCounts(entries, subject),
    [entries, subject]
  );
  const shown = useMemo(
    () => entriesFor(entries, subject, language),
    [entries, subject, language]
  );

  const pickSubject = (key: SubjectKey) => {
    setSubject(key);
    setLanguage((l) => firstLanguageWithEntries(entries, key, l));
  };

  const subjectName = useCallback(
    (o: SubjectOption | undefined) =>
      !o ? '' : o.builtin ? t(`subjects.${o.builtin}`) : (o.label ?? ''),
    [t]
  );

  const added = (entry: VoiceEntryRow) => {
    setLibrary((lib) =>
      lib ? { ...lib, entries: [entry, ...lib.entries] } : lib
    );
    setTab('send');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] flex-col gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>

        {loadError ? (
          <div className="space-y-2 text-sm">
            <p className="text-destructive">{t('loadFailed')}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RotateCcw className="h-4 w-4" aria-hidden />
              {t('retry')}
            </Button>
          </div>
        ) : !library ? (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t('loading')}
          </div>
        ) : (
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v === 'add' ? 'add' : 'send')}
            className="min-h-0 flex-1"
          >
            {canAdd && (
              <TabsList>
                <TabsTrigger value="send">{t('tabSend')}</TabsTrigger>
                <TabsTrigger value="add">{t('tabAdd')}</TabsTrigger>
              </TabsList>
            )}

            <TabsContent value="send" className="min-h-0 space-y-3">
              <SubjectAndLanguage
                subjects={subjects}
                subject={subject}
                onSubject={pickSubject}
                language={language}
                onLanguage={setLanguage}
                counts={counts}
                subjectName={subjectName}
              />
              <div className="max-h-[45dvh] space-y-2 overflow-y-auto pe-1">
                {shown.length === 0 ? (
                  <EmptyState
                    icon={AudioLines}
                    title={t('emptyTitle')}
                    hint={canAdd ? t('emptyHintAdd') : t('emptyHint')}
                    className="min-h-32"
                  />
                ) : (
                  shown.map((e) => (
                    <EntryRow
                      key={e.id}
                      entry={e}
                      conversationId={conversationId}
                      ttsAvailable={library.tts.available}
                      canDelete={canDeleteEntry(
                        e,
                        user?.id ?? null,
                        accountRole ?? null
                      )}
                      onSend={(note) => {
                        onSend(note);
                        onOpenChange(false);
                      }}
                      onDeleted={() =>
                        setLibrary((lib) =>
                          lib
                            ? {
                                ...lib,
                                entries: lib.entries.filter(
                                  (x) => x.id !== e.id
                                ),
                              }
                            : lib
                        )
                      }
                    />
                  ))
                )}
              </div>
            </TabsContent>

            {canAdd && (
              <TabsContent value="add" className="min-h-0 overflow-y-auto">
                <AddEntryForm
                  open={open && tab === 'add'}
                  subjects={subjects}
                  subject={subject}
                  onSubject={setSubject}
                  language={language}
                  onLanguage={setLanguage}
                  subjectName={subjectName}
                  tts={library.tts}
                  onSubjectAdded={(s) =>
                    setLibrary((lib) =>
                      lib ? { ...lib, subjects: [...lib.subjects, s] } : lib
                    )
                  }
                  onAdded={added}
                />
              </TabsContent>
            )}
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SubjectAndLanguage({
  subjects,
  subject,
  onSubject,
  language,
  onLanguage,
  counts,
  subjectName,
  idPrefix = 'voice-lib',
}: {
  subjects: SubjectOption[];
  subject: SubjectKey;
  onSubject: (key: SubjectKey) => void;
  language: VoiceLanguage;
  onLanguage: (l: VoiceLanguage) => void;
  counts?: Record<VoiceLanguage, number>;
  subjectName: (o: SubjectOption | undefined) => string;
  idPrefix?: string;
}) {
  const t = useTranslations('VoiceLibrary');
  const current = subjects.find((s) => s.key === subject);
  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-subject`}>{t('subject')}</Label>
        <Select
          value={subject}
          onValueChange={(v) => v && onSubject(String(v))}
        >
          <SelectTrigger id={`${idPrefix}-subject`} className="w-full">
            <SelectValue>{subjectName(current)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {subjects.map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {counts
                  ? t('subjectWithCount', {
                      name: subjectName(s),
                      count: s.count,
                    })
                  : subjectName(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div
        role="radiogroup"
        aria-label={t('language')}
        className="grid grid-cols-2 gap-1.5 sm:grid-cols-4"
      >
        {VOICE_LANGUAGES.map((l) => (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={language === l}
            onClick={() => onLanguage(l)}
            className={cn(
              'border-input flex items-center justify-between gap-1 rounded-md border px-2.5 py-1.5 text-sm transition-colors',
              language === l
                ? 'border-primary bg-primary/10 text-foreground font-medium'
                : 'bg-card text-muted-foreground hover:bg-muted dark:bg-input/30'
            )}
          >
            <span>{t(`languages.${l}`)}</span>
            {counts && (
              <span className="text-xs tabular-nums">{counts[l]}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function EntryRow({
  entry,
  conversationId,
  ttsAvailable,
  canDelete,
  onSend,
  onDeleted,
}: {
  entry: VoiceEntryRow;
  conversationId: string;
  ttsAvailable: boolean;
  canDelete: boolean;
  onSend: (note: VoiceLibrarySend) => void;
  onDeleted: () => void;
}) {
  const t = useTranslations('VoiceLibrary');
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const send = async () => {
    if (!entry.personalised) {
      if (entry.media_url) onSend({ mediaUrl: entry.media_url, path: '' });
      return;
    }
    setSending(true);
    try {
      const res = await fetch(`/api/voice-library/entries/${entry.id}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        mediaUrl?: string;
        path?: string;
        error?: string;
      };
      if (!res.ok || !body.mediaUrl || !body.path) {
        toast.error(body.error ?? t('renderFailed'));
        return;
      }
      onSend({ mediaUrl: body.mediaUrl, path: body.path });
    } catch {
      toast.error(t('renderFailed'));
    } finally {
      setSending(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/voice-library/entries/${entry.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(body.error ?? t('deleteFailed'));
        return;
      }
      onDeleted();
    } catch {
      toast.error(t('deleteFailed'));
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  const personalisedBlocked = entry.personalised && !ttsAvailable;

  return (
    <div className="bg-card-2 space-y-2 rounded-lg border p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {entry.title}
        </span>
        <Badge variant="outline" className="gap-1">
          {entry.source === 'recording' ? (
            <Mic className="h-3 w-3" aria-hidden />
          ) : (
            <Sparkles className="h-3 w-3" aria-hidden />
          )}
          {entry.source === 'recording' ? t('kindRecorded') : t('kindAi')}
        </Badge>
        {entry.personalised && (
          <Badge variant="outline" className="gap-1">
            <UserRound className="h-3 w-3" aria-hidden />
            {t('kindPersonalised')}
          </Badge>
        )}
      </div>

      {entry.personalised ? (
        <p
          className="text-muted-foreground line-clamp-3 text-xs"
          dir={RTL_LANGUAGES.includes(entry.language) ? 'rtl' : 'auto'}
        >
          {entry.script}
        </p>
      ) : (
        <VoiceNotePlayer
          src={entry.media_url}
          seed={entry.id}
          tone="chat"
          knownDuration={
            entry.duration_ms ? Math.round(entry.duration_ms / 1000) : undefined
          }
        />
      )}

      {personalisedBlocked && (
        <p className="text-muted-foreground text-xs">{t('personalisedOff')}</p>
      )}

      <div className="flex items-center justify-end gap-1.5">
        {canDelete &&
          (confirming ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
                disabled={deleting}
              >
                {t('cancel')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void remove()}
                disabled={deleting}
              >
                {deleting ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="h-4 w-4" aria-hidden />
                )}
                {t('confirmDelete')}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(true)}
              aria-label={t('deleteNamed', { title: entry.title })}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              <span className="max-sm:sr-only">{t('delete')}</span>
            </Button>
          ))}
        <Button
          size="sm"
          onClick={() => void send()}
          disabled={sending || personalisedBlocked}
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Send className="h-4 w-4" aria-hidden />
          )}
          {sending ? t('preparing') : t('send')}
        </Button>
      </div>
    </div>
  );
}

function AddEntryForm({
  open,
  subjects,
  subject,
  onSubject,
  language,
  onLanguage,
  subjectName,
  tts,
  onSubjectAdded,
  onAdded,
}: {
  open: boolean;
  subjects: SubjectOption[];
  subject: SubjectKey;
  onSubject: (key: SubjectKey) => void;
  language: VoiceLanguage;
  onLanguage: (l: VoiceLanguage) => void;
  subjectName: (o: SubjectOption | undefined) => string;
  tts: VoiceLibraryPayload['tts'];
  onSubjectAdded: (s: VoiceLibraryPayload['subjects'][number]) => void;
  onAdded: (entry: VoiceEntryRow) => void;
}) {
  const t = useTranslations('VoiceLibrary');
  const [newSubject, setNewSubject] = useState('');
  const [addingSubject, setAddingSubject] = useState(false);
  const [title, setTitle] = useState('');
  const [method, setMethod] = useState<Method>('record');
  const [script, setScript] = useState('');
  const [personalised, setPersonalised] = useState(false);
  const [voice, setVoice] = useState<TtsVoice>(DEFAULT_TTS_VOICE);
  const [saving, setSaving] = useState(false);

  // ---- Recording: the composer's recorder pieces (opus-recorder,
  // Ogg/Opus in the browser, and its recording bar).
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [take, setTake] = useState<{
    bytes: Uint8Array;
    url: string;
    seconds: number;
  } | null>(null);
  const recorderRef = useRef<import('opus-recorder').default | null>(null);
  const cancelledRef = useRef(false);
  const secondsRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const stopRecording = useCallback(() => {
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, []);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    stopRecording();
  }, [stopRecording]);

  // Leaving the tab or closing the dialog releases the mic.
  useEffect(() => {
    if (!open) cancelRecording();
  }, [open, cancelRecording]);
  useEffect(
    () => () => {
      cancelledRef.current = true;
      clearTimer();
      void recorderRef.current?.stop().catch(() => {});
    },
    []
  );
  useEffect(() => {
    if (recording && seconds >= MAX_RECORDING_SECONDS) stopRecording();
  }, [recording, seconds, stopRecording]);
  useEffect(
    () => () => {
      if (take) URL.revokeObjectURL(take.url);
    },
    [take]
  );

  const startRecording = async () => {
    if (recording) return;
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioContext === 'undefined'
    ) {
      toast.error(t('recordUnsupported'));
      return;
    }
    try {
      const { default: Recorder } = await import('opus-recorder');
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048,
        encoderSampleRate: 48000,
        streamPages: false,
      });
      cancelledRef.current = false;
      recorder.ondataavailable = (bytes) => {
        if (cancelledRef.current || bytes.byteLength === 0) return;
        const blob = new Blob([bytes as unknown as BlobPart], {
          type: 'audio/ogg',
        });
        setTake({
          bytes,
          url: URL.createObjectURL(blob),
          seconds: secondsRef.current,
        });
      };
      recorderRef.current = recorder;
      await recorder.start();
      setTake(null);
      setRecording(true);
      setSeconds(0);
      secondsRef.current = 0;
      timerRef.current = setInterval(() => {
        secondsRef.current += 1;
        setSeconds(secondsRef.current);
      }, 1000);
    } catch {
      void recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
      toast.error(t('micDenied'));
    }
  };

  const getLevelSource = useCallback(() => recorderRef.current, []);

  // ---- Subject
  const addSubject = async () => {
    const label = newSubject.trim();
    if (!label) return;
    setAddingSubject(true);
    try {
      const res = await fetch('/api/voice-library/subjects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        subject?: VoiceLibraryPayload['subjects'][number];
        error?: string;
      };
      if (!res.ok || !body.subject) {
        toast.error(body.error ?? t('subjectFailed'));
        return;
      }
      onSubjectAdded(body.subject);
      onSubject(body.subject.id);
      setNewSubject('');
    } finally {
      setAddingSubject(false);
    }
  };

  // ---- Save
  const problem =
    method === 'tts' && script ? scriptProblem(script, personalised) : null;
  const ready =
    !!title.trim() &&
    !recording &&
    (method === 'record'
      ? !!take && take.bytes.byteLength <= VOICE_MAX_BYTES
      : tts.available && !!script.trim() && !problem);

  const save = async () => {
    if (!ready) return;
    const form = new FormData();
    form.set('subject', subject);
    form.set('language', language);
    form.set('title', title.trim());
    if (method === 'record' && take) {
      form.set('source', 'recording');
      form.set('duration_ms', String(take.seconds * 1000));
      form.set(
        'file',
        new Blob([take.bytes as unknown as BlobPart], { type: 'audio/ogg' }),
        'voice-note.ogg'
      );
    } else {
      form.set('source', 'tts');
      form.set('script', script);
      form.set('personalised', personalised ? 'true' : 'false');
      form.set('voice', voice);
    }
    setSaving(true);
    try {
      const res = await fetch('/api/voice-library/entries', {
        method: 'POST',
        body: form,
      });
      const body = (await res.json().catch(() => ({}))) as {
        entry?: VoiceEntryRow;
        error?: string;
      };
      if (!res.ok || !body.entry) {
        toast.error(body.error ?? t('saveFailed'));
        return;
      }
      toast.success(t('saved'));
      onAdded(body.entry);
      setTitle('');
      setScript('');
      setTake(null);
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const rtl = RTL_LANGUAGES.includes(language);

  return (
    <div className="space-y-3 pb-1">
      <SubjectAndLanguage
        subjects={subjects}
        subject={subject}
        onSubject={onSubject}
        language={language}
        onLanguage={onLanguage}
        subjectName={subjectName}
        idPrefix="voice-lib-add"
      />

      <div className="flex gap-1.5">
        <Input
          value={newSubject}
          onChange={(e) => setNewSubject(e.target.value)}
          maxLength={SUBJECT_LABEL_MAX}
          placeholder={t('newSubjectPlaceholder')}
          aria-label={t('newSubject')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void addSubject();
            }
          }}
        />
        <Button
          variant="outline"
          onClick={() => void addSubject()}
          disabled={addingSubject || !newSubject.trim()}
        >
          {addingSubject ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Plus className="h-4 w-4" aria-hidden />
          )}
          {t('addSubject')}
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="voice-lib-title">{t('entryTitle')}</Label>
        <Input
          id="voice-lib-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={ENTRY_TITLE_MAX}
          placeholder={t('entryTitlePlaceholder')}
        />
      </div>

      <RadioGroup
        value={method}
        onValueChange={(v) => setMethod(v === 'tts' ? 'tts' : 'record')}
        aria-label={t('method')}
        className="gap-1.5"
      >
        <label className="flex items-center gap-2 text-sm">
          <RadioGroupItem value="record" />
          <Mic className="h-4 w-4" aria-hidden />
          {t('methodRecord')}
        </label>
        <label
          className={cn(
            'flex items-center gap-2 text-sm',
            !tts.available && 'text-muted-foreground'
          )}
        >
          <RadioGroupItem value="tts" disabled={!tts.available} />
          <Sparkles className="h-4 w-4" aria-hidden />
          {t('methodAi')}
        </label>
      </RadioGroup>
      {!tts.available && (
        <p className="text-muted-foreground text-xs">
          {t(`ttsUnavailable.${tts.reason}`)}
        </p>
      )}

      {method === 'record' ? (
        recording ? (
          <VoiceRecordingBar
            seconds={seconds}
            maxSeconds={MAX_RECORDING_SECONDS}
            getLevelSource={getLevelSource}
            onCancel={cancelRecording}
            onStop={stopRecording}
            stopClassName={SEND_BUTTON}
          />
        ) : take ? (
          <div className="space-y-2">
            <VoiceNotePlayer
              src={take.url}
              seed="voice-library-take"
              tone="chat"
              knownDuration={take.seconds}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => void startRecording()}
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
              {t('recordAgain')}
            </Button>
          </div>
        ) : (
          <Button variant="outline" onClick={() => void startRecording()}>
            <Mic className="h-4 w-4" aria-hidden />
            {t('startRecording')}
          </Button>
        )
      ) : (
        <div className="space-y-2">
          <div className="space-y-1.5">
            <Label htmlFor="voice-lib-script">{t('script')}</Label>
            <Textarea
              id="voice-lib-script"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              maxLength={SCRIPT_MAX}
              rows={4}
              dir={rtl ? 'rtl' : 'auto'}
              placeholder={
                personalised
                  ? (t.raw('scriptPlaceholderPersonalised') as string)
                  : t('scriptPlaceholder')
              }
            />
            {problem && (
              <p className="text-destructive text-xs">
                {t.raw(`scriptProblems.${problem}`) as string}
              </p>
            )}
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Switch
              checked={personalised}
              onCheckedChange={(v) => setPersonalised(v === true)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">{t('personalise')}</span>
              <span className="text-muted-foreground block text-xs">
                {t.raw('personaliseHint') as string}
              </span>
            </span>
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="voice-lib-voice">{t('voice')}</Label>
            <Select
              value={voice}
              onValueChange={(v) => isTtsVoice(v) && setVoice(v)}
            >
              <SelectTrigger id="voice-lib-voice" className="w-full">
                <SelectValue>{t(`voices.${voice}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {TTS_VOICES.map((v) => (
                  <SelectItem key={v} value={v}>
                    {t(`voices.${v}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-muted-foreground text-xs">{t('aiNotice')}</p>
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={() => void save()} disabled={!ready || saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {saving
            ? method === 'tts' && !personalised
              ? t('generating')
              : t('saving')
            : t('save')}
        </Button>
      </div>
    </div>
  );
}
