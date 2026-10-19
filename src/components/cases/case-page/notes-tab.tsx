'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AtSign, Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import type { CaseTabProps } from '@/lib/cases/case-page';
import {
  insertMention,
  renderMentions,
  toolErrorKey,
} from '@/lib/cases/case-tools-ui';

import { sendCaseRequest } from './case-dialogs';
import {
  asList,
  asObj,
  asStr,
  TabStatus,
  useCaseResource,
  useWhen,
} from './tab-kit';

const NOTE_MAX = 10000;

interface Note {
  id: string;
  authorId: string | null;
  body: string;
  createdAt: string;
}

function parse(json: unknown): Note[] {
  return asList(asObj(json)?.notes)
    .flatMap((v) => {
      const r = asObj(v);
      const id = asStr(r?.id);
      const body = asStr(r?.body);
      if (!r || !id || body === null) return [];
      return [
        {
          id,
          authorId: asStr(r.authorId),
          body,
          createdAt: asStr(r.createdAt) ?? '',
        },
      ];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const handles = (v: unknown): string[] =>
  asList(v)
    .filter((h): h is string => typeof h === 'string')
    .map((h) => h.replace(/^@/, ''));

/** Internal notes, newest first, with an @-mention composer. */
export function NotesTab({ caseId, detail }: CaseTabProps) {
  const t = useTranslations('CasePage');
  const when = useWhen();
  const { members, nameOf } = useWorkspaceMembers();
  const { data, failed, reload } = useCaseResource(
    `/api/cases/${caseId}/notes`,
    parse
  );
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [result, setResult] = useState<{
    mentioned: string[];
    ignored: string[];
  } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const cursor = useRef(0);

  const canWrite = detail.permissions.canWrite;
  const people = members.filter((m) => !m.deactivated_at);
  const label = (id: string) => nameOf(id) ?? id;

  const onType = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    const at = e.target.selectionStart ?? next.length;
    cursor.current = at;
    // A fresh "@" at a word start opens the picker.
    if (
      next.length === body.length + 1 &&
      next[at - 1] === '@' &&
      (at === 1 || /\s/.test(next[at - 2]))
    )
      setPicking(true);
    setBody(next);
  };

  const pick = (userId: string) => {
    const r = insertMention(body, cursor.current, userId);
    setBody(r.body);
    cursor.current = r.cursor;
    setPicking(false);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(r.cursor, r.cursor);
    });
  };

  const post = async () => {
    const text = body.trim();
    if (!text) return toast.error(t('notes.errors.empty'));
    setBusy(true);
    const r = await sendCaseRequest(`/api/cases/${caseId}/notes`, 'POST', {
      body: text,
    });
    setBusy(false);
    if (!r.ok) {
      const code = (r.json as { code?: unknown } | null)?.code;
      toast.error(t(toolErrorKey(r.status, code)));
      return;
    }
    const res = asObj(r.json);
    setResult({
      mentioned: handles(res?.mentioned),
      ignored: handles(res?.ignored),
    });
    setBody('');
    cursor.current = 0;
    toast.success(t('notes.posted'));
    void reload();
  };

  return (
    <div className="space-y-3">
      {canWrite && (
        <section className="bg-card space-y-2 rounded-lg border p-3">
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Lock className="size-3.5 shrink-0" aria-hidden />
            {t('notes.internal')}
          </p>
          <Textarea
            ref={area}
            value={body}
            maxLength={NOTE_MAX}
            rows={3}
            placeholder={t('notes.placeholder')}
            aria-label={t('notes.title')}
            onChange={onType}
            onSelect={(e) => {
              cursor.current = e.currentTarget.selectionStart ?? 0;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void post();
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <DropdownMenu open={picking} onOpenChange={setPicking}>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="sm" type="button" />}
              >
                <AtSign className="size-4" aria-hidden />
                {t('notes.mention')}
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-72 min-w-56 overflow-y-auto"
              >
                {people.length === 0 ? (
                  <p className="text-muted-foreground px-2 py-1.5 text-sm">
                    {t('notes.noMembers')}
                  </p>
                ) : (
                  people.map((m) => (
                    <DropdownMenuItem
                      key={m.user_id}
                      onClick={() => pick(m.user_id)}
                    >
                      {m.full_name || m.email}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs tabular-nums">
                {t('notes.count', { count: body.length, max: NOTE_MAX })}
              </span>
              <Button
                size="sm"
                disabled={busy || !body.trim()}
                onClick={() => void post()}
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                {t('notes.post')}
              </Button>
            </div>
          </div>
          {result && result.mentioned.length > 0 && (
            <p className="text-muted-foreground text-xs" role="status">
              {t('notes.mentioned', {
                names: result.mentioned.map(label).join(', '),
              })}
            </p>
          )}
          {result && result.ignored.length > 0 && (
            <p
              className="border-wa-warning/30 bg-wa-warning/10 text-wa-warning rounded-md border px-2 py-1 text-xs"
              role="status"
            >
              {t('notes.ignored', {
                names: result.ignored.map(label).join(', '),
              })}
            </p>
          )}
        </section>
      )}

      <section className="bg-card rounded-lg border p-3">
        <h2 className="mb-2 text-sm font-semibold">{t('notes.title')}</h2>
        {!canWrite && (
          <p className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs">
            <Lock className="size-3.5 shrink-0" aria-hidden />
            {t('notes.internal')}
          </p>
        )}
        {!data ? (
          <TabStatus
            failed={failed}
            loading={t('notes.loading')}
            error={t('notes.loadFailed')}
            onRetry={() => void reload()}
          />
        ) : data.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('notes.empty')}</p>
        ) : (
          <ul className="divide-y">
            {data.map((n) => (
              <li key={n.id} className="py-2">
                <p className="text-muted-foreground text-xs">
                  {n.authorId
                    ? (nameOf(n.authorId) ?? t('unknownPerson'))
                    : t('system')}
                  {' · '}
                  {when(n.createdAt) ?? '—'}
                </p>
                <p className="text-sm break-words whitespace-pre-wrap">
                  {renderMentions(n.body, nameOf).map((s, i) =>
                    s.kind === 'text' ? (
                      <span key={i}>{s.text}</span>
                    ) : (
                      <span key={i} className="text-primary font-medium">
                        @{s.name ?? t('notes.unknownMention')}
                      </span>
                    )
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
