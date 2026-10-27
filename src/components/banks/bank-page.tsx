'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowLeft, Lock, MessageSquare, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { canLeadTeam } from '@/lib/auth/roles';
import {
  BANK_CAPS,
  BANK_TABS,
  bankTab,
  currentPins,
  errorKey,
  isOverdue,
  localToIso,
  parseActions,
  parseBankPage,
  parseBankSummary,
  parsePins,
  parsePosts,
  parseThreads,
  PIN_KINDS,
  threadTree,
  type BankAction,
  type BankCase,
  type BankPin,
  type BankPost,
  type BankSpace,
  type BankSummary,
  type BankThread,
  type PinKind,
} from '@/lib/banks/ui';
import { caseStatusView } from '@/lib/cases/ui';
import { cn } from '@/lib/utils';

import { BankCasesTab } from './bank-cases-tab';
import { BankDashboardTab } from './bank-dashboard-tab';
import { BankSummaryStrip } from './bank-summary-strip';
import { chip } from './banks-list';

const NONE = '__none__';
type T = ReturnType<typeof useTranslations>;

/** One write; on failure a toast in plain words and null. */
async function write(
  t: T,
  url: string,
  method: 'POST' | 'PUT',
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => null);
    if (res.ok) return (json as Record<string, unknown>) ?? {};
    toast.error(t(`errors.${errorKey(res.status, json)}`));
  } catch {
    toast.error(t('errors.failed'));
  }
  return null;
}

/** GET a list with a seq guard; null while loading, 'error' on failure. */
function useList<R>(url: string, parse: (j: unknown) => R[]) {
  const [rows, setRows] = useState<R[] | null | 'error'>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const list = parse(await res.json());
      if (mine === seq.current) setRows(list);
    } catch {
      if (mine === seq.current) setRows('error');
    }
  }, [url, parse]);
  useEffect(() => {
    void load();
  }, [load]);
  return { rows, reload: load };
}

function useWhen() {
  const locale = useLocale();
  return (iso: string | null) => {
    const d = iso ? new Date(iso) : null;
    return d && Number.isFinite(d.getTime())
      ? d.toLocaleString(locale, {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';
  };
}

function ListState({
  rows,
  reload,
  empty,
}: {
  rows: unknown[] | null | 'error';
  reload: () => void;
  empty: string;
}) {
  const t = useTranslations('Banks');
  if (rows === null)
    return <p className="text-muted-foreground py-6 text-sm">{t('loading')}</p>;
  if (rows === 'error')
    return (
      <div className="flex items-center gap-3 py-4">
        <p className="text-destructive text-sm">{t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={reload}>
          {t('retry')}
        </Button>
      </div>
    );
  if (rows.length === 0)
    return <p className="text-muted-foreground py-6 text-sm">{empty}</p>;
  return null;
}

/** /banks/[id] — one bank's internal space (module 019). */
export function BankPage({ bankWsId }: { bankWsId: string }) {
  const t = useTranslations('Banks');
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const tab = bankTab(search.get('tab'));
  const threadId = search.get('thread');
  const setQuery = (next: Record<string, string | null>) => {
    const qs = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(next))
      if (v === null) qs.delete(k);
      else qs.set(k, v);
    const s = qs.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

  const { user, accountRole } = useAuth();
  const [page, setPage] = useState<
    { workspace: BankSpace; cases: BankCase[] } | 'missing' | 'error' | null
  >(null);
  const loadPage = useCallback(async () => {
    try {
      const res = await fetch(`/api/banks/${bankWsId}`, { cache: 'no-store' });
      if (res.status === 404) return setPage('missing');
      if (!res.ok) throw new Error(String(res.status));
      const p = parseBankPage(await res.json());
      setPage(
        p.workspace ? { workspace: p.workspace, cases: p.cases } : 'error'
      );
    } catch {
      setPage('error');
    }
  }, [bankWsId]);
  // The header's figures load on their own: any failure only hides the
  // strip, never the page.
  const [summary, setSummary] = useState<BankSummary | null>(null);
  const loadSummary = useCallback(async () => {
    try {
      const res = await fetch(`/api/banks/${bankWsId}/summary`, {
        cache: 'no-store',
      });
      setSummary(res.ok ? parseBankSummary(await res.json()) : null);
    } catch {
      setSummary(null);
    }
  }, [bankWsId]);
  useEffect(() => {
    void loadPage();
    void loadSummary();
  }, [loadPage, loadSummary]);

  const back = (
    <Link
      href="/banks"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {t('backToBanks')}
    </Link>
  );
  if (page === null)
    return <div className="bg-muted m-6 h-40 animate-pulse rounded-xl" />;
  if (page === 'missing' || page === 'error')
    return (
      <div className="mx-auto max-w-5xl space-y-3">
        {back}
        <p className="text-destructive text-sm">
          {page === 'missing' ? t('notFound') : t('loadFailed')}
        </p>
        {page === 'error' && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void loadPage();
              void loadSummary();
            }}
          >
            {t('retry')}
          </Button>
        )}
      </div>
    );

  const me = user?.id ?? null;
  // Mirrors who the pins PUT accepts; the server still decides (403).
  const canEditPins =
    (accountRole !== null && canLeadTeam(accountRole)) ||
    page.cases.some(
      (c) => !c.closedAt && me !== null && c.coordinatorId === me
    );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      {back}
      <div className="min-w-0">
        <h1 className="text-xl font-bold">
          {page.workspace.bankName}{' '}
          <span className="text-muted-foreground text-sm font-normal">
            {page.workspace.bankCode}
          </span>
        </h1>
        <p className="text-muted-foreground flex items-start gap-1.5 text-sm">
          <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t('pageSubtitle')}
        </p>
      </div>
      {summary && <BankSummaryStrip summary={summary} />}
      <Tabs
        value={tab}
        onValueChange={(v) => setQuery({ tab: String(v), thread: null })}
      >
        <div className="overflow-x-auto">
          <TabsList>
            {BANK_TABS.map((k) => (
              <TabsTrigger key={k} value={k}>
                {t(`tabs.${k}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="threads">
          {threadId ? (
            <ThreadView
              key={threadId}
              bankWsId={bankWsId}
              threadId={threadId}
              cases={page.cases}
              me={me}
              onBack={() => setQuery({ thread: null })}
            />
          ) : (
            <ThreadsTab
              bankWsId={bankWsId}
              cases={page.cases}
              onOpen={(id) => setQuery({ thread: id })}
            />
          )}
        </TabsContent>
        <TabsContent value="pinned">
          <PinnedTab bankWsId={bankWsId} canEdit={canEditPins} />
        </TabsContent>
        <TabsContent value="actions">
          <ActionsTab
            bankWsId={bankWsId}
            onOpen={(id) => setQuery({ tab: 'threads', thread: id })}
          />
        </TabsContent>
        <TabsContent value="cases">
          <BankCasesTab bankWsId={bankWsId} />
        </TabsContent>
        <TabsContent value="dashboard">
          <BankDashboardTab bankWsId={bankWsId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function caseLabel(c: BankCase) {
  return (
    [caseStatusView(c).text, c.product].filter(Boolean).join(' · ') ||
    c.caseId.slice(0, 8)
  );
}

function CaseSelect({
  cases,
  value,
  onChange,
}: {
  cases: BankCase[];
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const t = useTranslations('Banks');
  const shown = cases.find((c) => c.caseId === value);
  return (
    <div className="space-y-1">
      <Label>{t('threads.linkLabel')}</Label>
      <Select
        value={value ?? NONE}
        onValueChange={(v) =>
          onChange(v === NONE || typeof v !== 'string' ? null : v)
        }
      >
        <SelectTrigger className="w-full">
          <SelectValue>
            {shown ? caseLabel(shown) : t('threads.noLink')}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t('threads.noLink')}</SelectItem>
          {cases.map((c) => (
            <SelectItem key={c.caseId} value={c.caseId}>
              {caseLabel(c)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ThreadsTab({
  bankWsId,
  cases,
  onOpen,
}: {
  bankWsId: string;
  cases: BankCase[];
  onOpen: (threadId: string) => void;
}) {
  const t = useTranslations('Banks');
  const when = useWhen();
  const { nameOf } = useWorkspaceMembers();
  const name = (id: string | null) => (id && nameOf(id)) || t('unknownPerson');
  const { rows, reload } = useList(
    `/api/banks/${bankWsId}/threads`,
    parseThreads
  );
  const [open, setOpen] = useState(false);
  const caseById = new Map(cases.map((c) => [c.caseId, c]));
  return (
    <div className="space-y-3 pt-2">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="size-4" aria-hidden />
          {t('threads.newThread')}
        </Button>
      </div>
      <ListState
        rows={rows}
        reload={() => void reload()}
        empty={t('threads.empty')}
      />
      {Array.isArray(rows) && rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((th: BankThread) => {
            const c = th.caseId ? caseById.get(th.caseId) : undefined;
            return (
              <li key={th.threadId}>
                <button
                  type="button"
                  onClick={() => onOpen(th.threadId)}
                  className="border-border bg-card hover:bg-accent block w-full space-y-1.5 rounded-xl border p-3 text-left transition-colors"
                >
                  <span className="block font-semibold break-words">
                    {th.title}
                  </span>
                  <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span>
                      {t('threads.byWhom', {
                        name: name(th.authorId),
                        when: when(th.createdAt),
                      })}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <MessageSquare className="size-3.5" aria-hidden />
                      {t('threads.posts', { count: th.postCount })}
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    {th.caseId && (
                      <span className={cn(chip, 'bg-muted text-foreground')}>
                        {c
                          ? t('threads.caseChip', { stage: caseLabel(c) })
                          : t('threads.caseHidden')}
                      </span>
                    )}
                    {th.actionDueAt && (
                      <span
                        className={cn(chip, 'bg-warning-soft text-warning')}
                      >
                        {t('threads.actionChip', {
                          name: name(th.actionOwnerId),
                          due: when(th.actionDueAt),
                        })}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <NewThreadDialog
        open={open}
        onOpenChange={setOpen}
        bankWsId={bankWsId}
        cases={cases}
        onCreated={(id) => {
          setOpen(false);
          onOpen(id);
        }}
      />
    </div>
  );
}

function NewThreadDialog({
  open,
  onOpenChange,
  bankWsId,
  cases,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  bankWsId: string;
  cases: BankCase[];
  onCreated: (threadId: string) => void;
}) {
  const t = useTranslations('Banks');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [caseId, setCaseId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ok = title.trim() !== '' && body.trim() !== '';
  const submit = async () => {
    setBusy(true);
    const res = await write(t, `/api/banks/${bankWsId}/threads`, 'POST', {
      title: title.trim(),
      body: body.trim(),
      ...(caseId ? { case_id: caseId } : {}),
    });
    setBusy(false);
    if (res && typeof res.threadId === 'string') {
      setTitle('');
      setBody('');
      setCaseId(null);
      onCreated(res.threadId);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('threads.newThread')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="bank-thread-title">{t('threads.titleLabel')}</Label>
            <Input
              id="bank-thread-title"
              value={title}
              maxLength={BANK_CAPS.title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bank-thread-body">{t('threads.bodyLabel')}</Label>
            <Textarea
              id="bank-thread-body"
              rows={5}
              value={body}
              maxLength={BANK_CAPS.body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          {cases.length > 0 && (
            <CaseSelect cases={cases} value={caseId} onChange={setCaseId} />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('threads.cancel')}
          </Button>
          <Button disabled={!ok || busy} onClick={() => void submit()}>
            {busy ? t('threads.creating') : t('threads.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Composer({
  placeholder,
  onSend,
  autoFocus,
}: {
  placeholder: string;
  onSend: (body: string) => Promise<boolean>;
  autoFocus?: boolean;
}) {
  const t = useTranslations('Banks');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-end gap-2">
      <Textarea
        rows={2}
        value={body}
        autoFocus={autoFocus}
        placeholder={placeholder}
        maxLength={BANK_CAPS.body}
        onChange={(e) => setBody(e.target.value)}
      />
      <Button
        disabled={busy || body.trim() === ''}
        onClick={async () => {
          setBusy(true);
          if (await onSend(body.trim())) setBody('');
          setBusy(false);
        }}
      >
        {busy ? t('threads.sending') : t('threads.send')}
      </Button>
    </div>
  );
}

function ThreadView({
  bankWsId,
  threadId,
  cases,
  me,
  onBack,
}: {
  bankWsId: string;
  threadId: string;
  cases: BankCase[];
  me: string | null;
  onBack: () => void;
}) {
  const t = useTranslations('Banks');
  const when = useWhen();
  const { members, nameOf } = useWorkspaceMembers();
  const name = (id: string | null) => (id && nameOf(id)) || t('unknownPerson');
  const base = `/api/banks/${bankWsId}`;
  const posts = useList(`${base}/threads/${threadId}/posts`, parsePosts);
  const threads = useList(`${base}/threads`, parseThreads);
  const thread = Array.isArray(threads.rows)
    ? threads.rows.find((th) => th.threadId === threadId)
    : undefined;
  const tree = useMemo(
    () => (Array.isArray(posts.rows) ? threadTree(posts.rows) : []),
    [posts.rows]
  );
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [retracting, setRetracting] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);

  const post = async (body: string, parent: string | null) => {
    const res = await write(t, `${base}/threads/${threadId}/posts`, 'POST', {
      body,
      ...(parent ? { parent_post_id: parent } : {}),
    });
    if (!res) return false;
    setReplyTo(null);
    void posts.reload();
    return true;
  };

  const caseById = new Map(cases.map((c) => [c.caseId, c]));
  const renderPost = (p: BankPost, reply = false) => (
    <div
      className={cn(
        'rounded-lg p-3',
        reply ? 'bg-muted/50' : 'border-border bg-card border'
      )}
    >
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
        <span className="text-foreground font-medium">{name(p.authorId)}</span>
        <span>{when(p.createdAt)}</span>
        {p.caseId && (
          <span className={cn(chip, 'bg-muted text-foreground')}>
            {p.caseReadable && p.caseStage
              ? t('threads.caseChip', {
                  stage: [p.caseStage, p.caseProduct]
                    .filter(Boolean)
                    .join(' · '),
                })
              : caseById.has(p.caseId)
                ? t('threads.caseChip', {
                    stage: caseLabel(caseById.get(p.caseId)!),
                  })
                : t('threads.caseHidden')}
          </span>
        )}
      </div>
      {p.retracted ? (
        <p className="text-muted-foreground mt-1 text-sm italic">
          {t('threads.retracted')}
        </p>
      ) : (
        <p className="mt-1 text-sm break-words whitespace-pre-wrap">{p.body}</p>
      )}
      <div className="mt-1 flex gap-1">
        {!reply && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setReplyTo(replyTo === p.postId ? null : p.postId)}
          >
            {t('threads.reply')}
          </Button>
        )}
        {!p.retracted && me !== null && p.authorId === me && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRetracting(p.postId)}
          >
            {t('threads.retract')}
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-3 pt-2">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="size-4" aria-hidden />
        {t('threads.back')}
      </Button>
      {thread && (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="min-w-0 text-lg font-semibold break-words">
            {thread.title}
          </h2>
          {thread.actionDueAt ? (
            <span className={cn(chip, 'bg-warning-soft text-warning')}>
              {t('threads.actionChip', {
                name: name(thread.actionOwnerId),
                due: when(thread.actionDueAt),
              })}
            </span>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMarking(true)}
            >
              {t('threads.markAction')}
            </Button>
          )}
        </div>
      )}
      <ListState
        rows={posts.rows}
        reload={() => void posts.reload()}
        empty=""
      />
      <ul className="space-y-3">
        {tree.map((n) => (
          <li key={n.post.postId} className="space-y-2">
            {renderPost(n.post)}
            {(n.replies.length > 0 || replyTo === n.post.postId) && (
              <div className="border-border ml-4 space-y-2 border-l pl-3">
                {n.replies.map((r) => (
                  <div key={r.postId}>{renderPost(r, true)}</div>
                ))}
                {replyTo === n.post.postId && (
                  <Composer
                    autoFocus
                    placeholder={t('threads.replyPlaceholder')}
                    onSend={(b) => post(b, n.post.postId)}
                  />
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      <Composer
        placeholder={t('threads.composerPlaceholder')}
        onSend={(b) => post(b, null)}
      />
      <ConfirmDialog
        open={retracting !== null}
        onOpenChange={(o) => !o && setRetracting(null)}
        title={t('threads.retractTitle')}
        description={t('threads.retractBody')}
        cancelLabel={t('threads.cancel')}
        confirmLabel={t('threads.retract')}
        destructive
        onConfirm={async () => {
          const id = retracting;
          setRetracting(null);
          if (id && (await write(t, `${base}/posts/${id}/retract`, 'POST')))
            void posts.reload();
        }}
      />
      <MarkActionDialog
        open={marking}
        onOpenChange={setMarking}
        people={members
          .filter((m) => !m.deactivated_at)
          .map((m) => ({ id: m.user_id, name: m.full_name || m.email }))}
        onMark={async (ownerId, dueAt) => {
          const res = await write(
            t,
            `${base}/threads/${threadId}/action`,
            'POST',
            {
              owner_id: ownerId,
              due_at: dueAt,
            }
          );
          if (res) {
            setMarking(false);
            void threads.reload();
          }
        }}
      />
    </div>
  );
}

function MarkActionDialog({
  open,
  onOpenChange,
  people,
  onMark,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  people: Array<{ id: string; name: string }>;
  onMark: (ownerId: string, dueAt: string) => Promise<void>;
}) {
  const t = useTranslations('Banks');
  const [owner, setOwner] = useState<string | null>(null);
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const dueIso = localToIso(due);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('threads.markAction')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>{t('threads.ownerLabel')}</Label>
            <Select
              value={owner ?? ''}
              onValueChange={(v) =>
                setOwner(typeof v === 'string' && v ? v : null)
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  {people.find((p) => p.id === owner)?.name ??
                    t('threads.ownerPick')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {people.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bank-action-due">{t('threads.dueLabel')}</Label>
            <Input
              id="bank-action-due"
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('threads.cancel')}
          </Button>
          <Button
            disabled={!owner || !dueIso || busy}
            onClick={async () => {
              if (!owner || !dueIso) return;
              setBusy(true);
              await onMark(owner, dueIso);
              setBusy(false);
            }}
          >
            {busy ? t('threads.marking') : t('threads.mark')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PinnedTab({
  bankWsId,
  canEdit,
}: {
  bankWsId: string;
  canEdit: boolean;
}) {
  const t = useTranslations('Banks');
  const when = useWhen();
  const { nameOf } = useWorkspaceMembers();
  const name = (id: string | null) => (id && nameOf(id)) || t('unknownPerson');
  const url = `/api/banks/${bankWsId}/pins`;
  const pins = useList(url, parsePins);
  const history = useList(`${url}?history=1`, parsePins);
  const current = useMemo(
    () =>
      Array.isArray(pins.rows)
        ? currentPins(pins.rows)
        : new Map<PinKind, BankPin>(),
    [pins.rows]
  );
  const [editing, setEditing] = useState<PinKind | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState<PinKind | null>(null);
  if (pins.rows === null || pins.rows === 'error')
    return (
      <ListState rows={pins.rows} reload={() => void pins.reload()} empty="" />
    );
  return (
    <div className="space-y-3 pt-2">
      {!canEdit && (
        <p className="text-muted-foreground text-xs">{t('pinned.readOnly')}</p>
      )}
      {PIN_KINDS.map((kind) => {
        const pin = current.get(kind);
        return (
          <section
            key={kind}
            className="border-border bg-card space-y-2 rounded-xl border p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">{t(`pinned.kinds.${kind}`)}</h3>
              {canEdit && editing !== kind && (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowHistory(kind);
                      void history.reload();
                    }}
                  >
                    {t('pinned.history')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditing(kind);
                      setDraft(pin?.body ?? '');
                    }}
                  >
                    {t('pinned.edit')}
                  </Button>
                </div>
              )}
            </div>
            {editing === kind ? (
              <div className="space-y-2">
                <Textarea
                  rows={6}
                  value={draft}
                  maxLength={BANK_CAPS.pin}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <p className="text-muted-foreground flex justify-between gap-2 text-xs">
                  <span>{t('pinned.blankClears')}</span>
                  <span>
                    {t('threads.chars', {
                      used: draft.length,
                      max: BANK_CAPS.pin,
                    })}
                  </span>
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditing(null)}
                  >
                    {t('pinned.cancel')}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      const ok = await write(t, url, 'PUT', {
                        kind,
                        body: draft,
                      });
                      setBusy(false);
                      if (ok) {
                        setEditing(null);
                        void pins.reload();
                      }
                    }}
                  >
                    {busy ? t('pinned.saving') : t('pinned.save')}
                  </Button>
                </div>
              </div>
            ) : pin ? (
              <>
                <p className="text-sm break-words whitespace-pre-wrap">
                  {pin.body}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('pinned.byWhom', {
                    name: name(pin.authorId),
                    when: when(pin.createdAt),
                  })}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">
                {t('pinned.empty')}
              </p>
            )}
          </section>
        );
      })}
      <Dialog
        open={showHistory !== null}
        onOpenChange={(o) => !o && setShowHistory(null)}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {showHistory &&
                t('pinned.historyTitle', {
                  kind: t(`pinned.kinds.${showHistory}`),
                })}
            </DialogTitle>
          </DialogHeader>
          {Array.isArray(history.rows) ? (
            (() => {
              const versions = history.rows
                .filter((p) => p.kind === showHistory)
                .sort(
                  (a, b) =>
                    Date.parse(b.createdAt ?? '') -
                    Date.parse(a.createdAt ?? '')
                );
              return versions.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {t('pinned.historyEmpty')}
                </p>
              ) : (
                <ul className="space-y-3">
                  {versions.map((v) => (
                    <li
                      key={v.pinId}
                      className="border-border space-y-1 border-b pb-3 last:border-0"
                    >
                      <p className="text-muted-foreground text-xs">
                        {t('pinned.byWhom', {
                          name: name(v.authorId),
                          when: when(v.createdAt),
                        })}
                      </p>
                      {v.body.trim() === '' ? (
                        <p className="text-muted-foreground text-sm italic">
                          {t('pinned.cleared')}
                        </p>
                      ) : (
                        <p className="text-sm break-words whitespace-pre-wrap">
                          {v.body}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              );
            })()
          ) : (
            <ListState
              rows={history.rows}
              reload={() => void history.reload()}
              empty=""
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ActionsTab({
  bankWsId,
  onOpen,
}: {
  bankWsId: string;
  onOpen: (threadId: string) => void;
}) {
  const t = useTranslations('Banks');
  const when = useWhen();
  const { nameOf } = useWorkspaceMembers();
  const { rows, reload } = useList(
    `/api/banks/${bankWsId}/actions`,
    parseActions
  );
  const now = new Date();
  return (
    <div className="space-y-2 pt-2">
      <ListState
        rows={rows}
        reload={() => void reload()}
        empty={t('actions.empty')}
      />
      {Array.isArray(rows) && rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((a: BankAction) => {
            const late = isOverdue(a.dueAt, now) && a.taskStatus !== 'done';
            return (
              <li
                key={a.actionId}
                className="border-border bg-card flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3"
              >
                <div className="min-w-0 space-y-1 text-sm">
                  <p>
                    {t('actions.owner', {
                      name:
                        (a.ownerId && nameOf(a.ownerId)) || t('unknownPerson'),
                    })}
                  </p>
                  <p
                    className={cn(
                      'text-xs',
                      late
                        ? 'text-destructive font-medium'
                        : 'text-muted-foreground'
                    )}
                  >
                    {t('actions.due', { date: when(a.dueAt) })}
                    {late && ` · ${t('actions.overdue')}`}
                  </p>
                  <span className="flex flex-wrap gap-1.5">
                    {a.caseId && (
                      <Link
                        href={`/cases/${a.caseId}`}
                        className={cn(
                          chip,
                          'bg-muted text-foreground hover:underline'
                        )}
                      >
                        {t('actions.caseLinked')}
                      </Link>
                    )}
                    {a.taskStatus && (
                      <span className={cn(chip, 'bg-muted text-foreground')}>
                        {t('actions.task', { status: a.taskStatus })}
                      </span>
                    )}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onOpen(a.threadId)}
                >
                  {t('actions.thread')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
