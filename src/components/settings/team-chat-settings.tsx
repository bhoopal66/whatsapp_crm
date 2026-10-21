'use client';

import { useEffect, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Eraser, Eye, Info, Loader2, MessagesSquare } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import { invalidateCached } from '@/lib/client-cache';
import { adminReadPrivate } from '@/lib/chat/api';
import { ChatError } from '@/lib/chat/errors';
import { mentionSegments } from '@/lib/chat/mentions';
import type { ChatMessage } from '@/lib/chat/types';
import {
  confirmationMatches,
  reasonOk,
  type AdminChannelSummary,
} from '@/lib/chat/admin-tools';
import type { AccountMember } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import { SettingsPanelHead } from './settings-panel-head';

/** Same chip as a message row's mention (components/chat/message-row.tsx). */
const CHIP =
  'rounded px-1 font-semibold text-[#0E7C5A] bg-emerald-50 [[data-mode=dark]_&]:bg-emerald-500/15 [[data-mode=dark]_&]:text-emerald-300';

/** Chat.errors keys the erase route can answer with. */
const ERASE_ERROR_KEYS = new Set([
  'forbidden',
  'notFound',
  'invalid',
  'conflict',
  'unknown',
  'reasonRequired',
]);

const SELECT =
  'h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Settings → Team chat (admin+): the workspace switch, the audited read
 * of a private channel or DM, and (owner only) a person's erasure. The
 * RPCs enforce every rule; this form keeps the requests honest.
 */
export function TeamChatSettings() {
  const t = useTranslations('Settings.teamChat');
  const { accountId, isOwner } = useAuth();
  const supabase = useMemo(() => createClient(), []);

  // Deactivated members too: their messages are still there to read
  // and to erase. chat_people would leave them out.
  const [people, setPeople] = useState<AccountMember[] | null>(null);
  const [peopleFailed, setPeopleFailed] = useState(false);
  useEffect(() => {
    if (!accountId) return;
    let off = false;
    fetch('/api/account/members')
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !Array.isArray(json.members)) throw new Error();
        if (!off) setPeople(json.members as AccountMember[]);
      })
      .catch(() => {
        if (!off) {
          setPeople([]);
          setPeopleFailed(true);
        }
      });
    return () => {
      off = true;
    };
  }, [accountId]);

  return (
    <section className="animate-in fade-in-50 max-w-3xl space-y-6 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <ChatSwitchCard supabase={supabase} accountId={accountId} />
      <PrivateReadCard supabase={supabase} people={people ?? []} />
      {isOwner && <EraseCard people={people} peopleFailed={peopleFailed} />}
      <div className="border-border bg-muted/40 text-muted-foreground flex gap-2 rounded-xl border p-4 text-sm">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p>{t('retention')}</p>
      </div>
    </section>
  );
}

type Supabase = ReturnType<typeof createClient>;

function ChatSwitchCard({
  supabase,
  accountId,
}: {
  supabase: Supabase;
  accountId: string | null;
}) {
  const t = useTranslations('Settings.teamChat.switch');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let off = false;
    supabase
      .from('accounts')
      .select('internal_chat_enabled')
      .eq('id', accountId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (off) return;
        if (error || !data) toast.error(t('loadFailed'));
        else setEnabled(data.internal_chat_enabled !== false);
      });
    return () => {
      off = true;
    };
  }, [supabase, accountId, t]);

  async function change(next: boolean) {
    if (!accountId) return;
    setSaving(true);
    // The accounts_update policy limits this to admins; a refused update
    // comes back as no row rather than an error.
    const { data, error } = await supabase
      .from('accounts')
      .update({ internal_chat_enabled: next })
      .eq('id', accountId)
      .select('internal_chat_enabled')
      .maybeSingle();
    setSaving(false);
    if (error || !data) {
      toast.error(t('saveFailed'));
      return;
    }
    setEnabled(data.internal_chat_enabled !== false);
    // The chat composers read the switch through this key
    // (components/chat/use-write-block.ts); the auth context does not
    // carry it, so refreshProfile() would only remount this panel.
    invalidateCached(`chat:enabled:${accountId}`);
    toast.success(next ? t('turnedOn') : t('turnedOff'));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <MessagesSquare className="text-primary size-4" />
          <span id="team-chat-switch-label">{t('title')}</span>
        </CardTitle>
        <CardDescription
          id="team-chat-switch-desc"
          className="text-muted-foreground"
        >
          {t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <span className="text-foreground text-sm font-medium">
          {enabled === null ? t('loading') : enabled ? t('on') : t('off')}
        </span>
        <div className="flex items-center gap-2">
          {saving && (
            <Loader2 className="text-muted-foreground size-4 animate-spin" />
          )}
          <Switch
            checked={enabled ?? false}
            onCheckedChange={(next) => void change(next)}
            disabled={enabled === null || saving}
            aria-labelledby="team-chat-switch-label"
            aria-describedby="team-chat-switch-desc"
          />
        </div>
      </CardContent>
    </Card>
  );
}

function channelLabel(
  c: AdminChannelSummary,
  t: ReturnType<typeof useTranslations>
): string {
  return c.name ?? (c.memberNames.join(', ') || t('unnamedDm'));
}

function PrivateReadCard({
  supabase,
  people,
}: {
  supabase: Supabase;
  people: AccountMember[];
}) {
  const t = useTranslations('Settings.teamChat.read');
  const tErrors = useTranslations('Chat.errors');
  const format = useFormatter();
  const [channels, setChannels] = useState<AdminChannelSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reading, setReading] = useState(false);
  const [transcript, setTranscript] = useState<{
    channel: AdminChannelSummary;
    messages: ChatMessage[];
  } | null>(null);

  useEffect(() => {
    let off = false;
    fetch('/api/chat/admin/private-channels')
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !Array.isArray(json.channels)) throw new Error();
        if (!off) setChannels(json.channels as AdminChannelSummary[]);
      })
      .catch(() => {
        if (!off) {
          setChannels([]);
          setLoadFailed(true);
        }
      });
    return () => {
      off = true;
    };
  }, []);

  const needle = filter.trim().toLocaleLowerCase();
  const visible = (channels ?? []).filter((c) =>
    channelLabel(c, t).toLocaleLowerCase().includes(needle)
  );
  const selected = channels?.find((c) => c.id === selectedId) ?? null;
  const ready = !!selected && reasonOk(reason) && !reading;

  async function read() {
    if (!selected || !reasonOk(reason)) return;
    setReading(true);
    try {
      const messages = await adminReadPrivate(supabase, {
        channelId: selected.id,
        reason: reason.trim(),
      });
      setTranscript({ channel: selected, messages });
      // Every read is audited on its own reason.
      setReason('');
    } catch (err) {
      toast.error(tErrors(err instanceof ChatError ? err.key : 'unknown'));
    } finally {
      setReading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <Eye className="text-primary size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="team-chat-read-filter">{t('channelLabel')}</Label>
          <Input
            id="team-chat-read-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('filterPlaceholder')}
            disabled={!channels || channels.length === 0}
          />
          <div className="border-border max-h-64 overflow-y-auto rounded-lg border">
            {channels === null ? (
              <p className="text-muted-foreground flex items-center gap-2 p-3 text-sm">
                <Loader2 className="size-4 animate-spin" /> {t('loading')}
              </p>
            ) : loadFailed ? (
              <p className="text-destructive p-3 text-sm">{t('loadFailed')}</p>
            ) : visible.length === 0 ? (
              <p className="text-muted-foreground p-3 text-sm">
                {channels.length === 0 ? t('none') : t('noMatch')}
              </p>
            ) : (
              <ul className="divide-border divide-y">
                {visible.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-pressed={c.id === selectedId}
                      onClick={() => setSelectedId(c.id)}
                      className={cn(
                        'hover:bg-muted/60 flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm',
                        c.id === selectedId && 'bg-primary/10'
                      )}
                    >
                      <span className="min-w-0">
                        <span className="text-foreground block truncate font-medium">
                          {channelLabel(c, t)}
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {t(`kind.${c.kind}`)} ·{' '}
                          {t('memberCount', { count: c.memberCount })}
                          {c.archived && ` · ${t('archived')}`}
                        </span>
                      </span>
                      {c.lastActivityAt && (
                        <span className="text-muted-foreground shrink-0 text-xs">
                          {t('lastActivity', {
                            when: format.dateTime(new Date(c.lastActivityAt), {
                              dateStyle: 'medium',
                            }),
                          })}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="team-chat-read-reason">{t('reasonLabel')}</Label>
          <Textarea
            id="team-chat-read-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('reasonPlaceholder')}
            rows={2}
            maxLength={500}
          />
          <p className="text-muted-foreground text-xs">{t('reasonHint')}</p>
        </div>

        <p className="border-warning/30 bg-warning-soft text-warning flex gap-2 rounded-lg border p-3 text-sm">
          {t('auditWarning')}
        </p>

        <Button onClick={() => void read()} disabled={!ready}>
          {reading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Eye className="size-4" />
          )}
          {t('submit')}
        </Button>
      </CardContent>

      <Dialog
        open={transcript !== null}
        onOpenChange={(open) => {
          if (!open) setTranscript(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          {transcript && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {t('transcriptTitle', {
                    name: channelLabel(transcript.channel, t),
                  })}
                </DialogTitle>
                <DialogDescription>
                  {t('transcriptDesc', {
                    count: transcript.messages.length,
                  })}
                </DialogDescription>
              </DialogHeader>
              <Transcript messages={transcript.messages} people={people} />
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Transcript({
  messages,
  people,
}: {
  messages: ChatMessage[];
  people: AccountMember[];
}) {
  const t = useTranslations('Settings.teamChat.read');
  const tChat = useTranslations('Chat');
  const format = useFormatter();
  const mentionPeople = useMemo(
    () => people.map((p) => ({ userId: p.user_id, fullName: p.full_name })),
    [people]
  );
  const names = useMemo(
    () => new Map(people.map((p) => [p.user_id.toLowerCase(), p.full_name])),
    [people]
  );

  if (messages.length === 0)
    return <p className="text-muted-foreground text-sm">{t('empty')}</p>;

  return (
    <ol className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
      {messages.map((m) => (
        <li
          key={m.id}
          className={cn(m.threadRootId && 'border-border ml-3 border-l-2 pl-3')}
        >
          <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="text-foreground font-semibold">
              {m.authorKind === 'system'
                ? t('system')
                : names.get(String(m.authorId).toLowerCase()) ||
                  tChat('unknownPerson')}
            </span>
            <time className="text-muted-foreground" dateTime={m.createdAt}>
              {format.dateTime(new Date(m.createdAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </time>
            {m.threadRootId && (
              <span className="text-muted-foreground">{t('threadReply')}</span>
            )}
            {m.editedAt && !m.deletedAt && !m.erasedAt && (
              <span className="text-muted-foreground">
                {tChat('timeline.edited')}
              </span>
            )}
          </div>
          {m.erasedAt ? (
            <p className="text-muted-foreground text-sm italic">
              {t('erasedBody')}
            </p>
          ) : m.deletedAt ? (
            <p className="text-muted-foreground text-sm italic">
              {t('deletedBody')}
            </p>
          ) : (
            <p className="text-foreground text-sm break-words whitespace-pre-wrap">
              {mentionSegments(m.body, mentionPeople).map((s, i) =>
                s.type === 'text' ? (
                  s.text
                ) : s.type === 'mention' ? (
                  <span key={i} className={CHIP}>
                    @{s.name || tChat('unknownPerson')}
                  </span>
                ) : (
                  <span key={i} className={CHIP}>
                    @{s.kind}
                  </span>
                )
              )}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

interface EraseResult {
  name: string;
  messages: number | null;
  filesDeleted: number;
  filesFailed: number;
}

function EraseCard({
  people,
  peopleFailed,
}: {
  people: AccountMember[] | null;
  peopleFailed: boolean;
}) {
  const t = useTranslations('Settings.teamChat.erase');
  const tErrors = useTranslations('Chat.errors');
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [erasing, setErasing] = useState(false);
  const [result, setResult] = useState<EraseResult | null>(null);

  const sorted = useMemo(
    () =>
      [...(people ?? [])].sort((a, b) =>
        (a.full_name || a.email || '').localeCompare(
          b.full_name || b.email || ''
        )
      ),
    [people]
  );
  const person = sorted.find((p) => p.user_id === userId) ?? null;
  // What to type: their name, else their email, else the word ERASE.
  const word = person
    ? person.full_name.trim() || person.email?.trim() || 'ERASE'
    : '';
  const ready =
    !!person && reasonOk(reason) && confirmationMatches(typed, word);

  async function erase() {
    if (!person || !ready) return;
    setErasing(true);
    try {
      const res = await fetch('/api/chat/admin/erase-person', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: person.user_id, reason: reason.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          typeof json.key === 'string' && ERASE_ERROR_KEYS.has(json.key)
            ? tErrors(json.key)
            : t('failed')
        );
        return;
      }
      setResult({
        name: word,
        messages: typeof json.messages === 'number' ? json.messages : null,
        filesDeleted: Number(json.filesDeleted) || 0,
        filesFailed: Number(json.filesFailed) || 0,
      });
      setUserId('');
      setReason('');
      setTyped('');
    } catch {
      toast.error(t('failed'));
    } finally {
      setErasing(false);
    }
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <Eraser className="text-destructive size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:max-w-sm">
          <Label htmlFor="team-chat-erase-person">{t('personLabel')}</Label>
          <select
            id="team-chat-erase-person"
            value={userId}
            onChange={(e) => {
              setUserId(e.target.value);
              setTyped('');
            }}
            disabled={people === null || erasing}
            className={SELECT}
          >
            <option value="">
              {people === null ? t('loadingPeople') : t('personPlaceholder')}
            </option>
            {sorted.map((p) => (
              <option key={p.user_id} value={p.user_id}>
                {p.full_name || p.email || p.user_id}
                {p.deactivated_at ? ` (${t('deactivated')})` : ''}
              </option>
            ))}
          </select>
          {peopleFailed && (
            <p className="text-destructive text-xs">{t('peopleFailed')}</p>
          )}
        </div>

        <div className="grid gap-2">
          <Label htmlFor="team-chat-erase-reason">{t('reasonLabel')}</Label>
          <Textarea
            id="team-chat-erase-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('reasonPlaceholder')}
            rows={2}
            maxLength={500}
            disabled={erasing}
          />
        </div>

        {person && (
          <div className="grid gap-2 sm:max-w-sm">
            <Label htmlFor="team-chat-erase-confirm">
              {t('confirmLabel', { word })}
            </Label>
            <Input
              id="team-chat-erase-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              disabled={erasing}
            />
          </div>
        )}

        <p className="text-muted-foreground text-xs">{t('warning')}</p>

        <Button
          variant="destructive"
          onClick={() => void erase()}
          disabled={!ready || erasing}
        >
          {erasing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Eraser className="size-4" />
          )}
          {t('submit')}
        </Button>

        {result && (
          <div
            role="status"
            className="border-border bg-muted/40 rounded-lg border p-3 text-sm"
          >
            <p className="text-foreground font-medium">
              {t('doneTitle', { name: result.name })}
            </p>
            <p className="text-muted-foreground">
              {result.messages === null
                ? t('summaryFilesOnly', { files: result.filesDeleted })
                : t('summary', {
                    messages: result.messages,
                    files: result.filesDeleted,
                  })}
            </p>
            {result.filesFailed > 0 && (
              <p className="text-destructive">
                {t('filesFailed', { count: result.filesFailed })}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
