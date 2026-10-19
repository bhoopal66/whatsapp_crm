'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  CircleCheck,
  KeyRound,
  Loader2,
  Plus,
  ShieldAlert,
  Trash2,
} from 'lucide-react';

import {
  useMeetingTimeZone,
  useWorkspaceMembers,
} from '@/components/meetings/use-workspace-members';
import {
  RevealedValue,
  requestReveal,
} from '@/components/memory/reveal-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import {
  VAULT_REASON_MAX,
  VAULT_ROLE_NAMES,
  isVaultToken,
  parseAudit,
  parseVaultOverview,
  reasonLooksLikeIdentifier,
  vaultErrorKey,
  type VaultAuditView,
  type VaultOverviewView,
  type VaultRoleName,
  type VaultRoleView,
} from '@/lib/vault/ui';

import { SettingsPanelHead } from './settings-panel-head';

type Answer = { ok: boolean; status: number; body: unknown };

/** One vault route call (never cached); a network failure is a status-0 answer. */
async function call(url: string, init?: RequestInit): Promise<Answer> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    return {
      ok: res.ok,
      status: res.status,
      body: await res.json().catch(() => null),
    };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

const codeOf = (body: unknown): unknown =>
  body && typeof body === 'object' ? (body as { code?: unknown }).code : null;

type Loaded<T> = { data: T | null; failed: boolean };

async function read<T>(
  url: string,
  parse: (body: unknown) => T | null
): Promise<Loaded<T>> {
  const answer = await call(url);
  const data = answer.ok ? parse(answer.body) : null;
  return { data, failed: data === null };
}

/**
 * One GET, re-read on `reload()`; state lands only in the fetch's
 * callback (cases-settings-panel's useConfigRead). `parse` must be stable.
 */
function useVaultRead<T>(url: string, parse: (body: unknown) => T | null) {
  const [state, setState] = useState<Loaded<T> | null>(null);
  useEffect(() => {
    let off = false;
    void read(url, parse).then((next) => {
      if (!off) setState(next);
    });
    return () => {
      off = true;
    };
  }, [url, parse]);
  const reload = useCallback(async () => {
    setState(await read(url, parse));
  }, [url, parse]);
  return {
    data: state?.data ?? null,
    failed: state?.failed ?? false,
    reload,
  };
}

/** `Vault.errors.*` for a failed answer. */
function useErrorText() {
  const t = useTranslations('Vault.errors');
  return useCallback(
    (answer: Answer) => t(vaultErrorKey(answer.status, codeOf(answer.body))),
    [t]
  );
}

/** Names for auth user ids; a former member reads as the id's start. */
function useNames() {
  const { members, nameOf } = useWorkspaceMembers();
  const name = useCallback(
    (userId: string | null) =>
      userId === null ? '—' : (nameOf(userId) ?? `${userId.slice(0, 8)}…`),
    [nameOf]
  );
  return { members, name };
}

function useWhen() {
  const format = useFormatter();
  const timeZone = useMeetingTimeZone();
  return useCallback(
    (at: string | null) =>
      at === null
        ? '—'
        : format.dateTime(new Date(at), {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone,
          }),
    [format, timeZone]
  );
}

/**
 * Settings -> Vault (module 019c, owner / admin): whether the vault's
 * keys are set, its first super admin, who holds a vault role, reveal
 * and erase by token, and the audit trail. `/api/vault/*` (and the SQL
 * under it) decides everything; this screen only explains.
 */
export function VaultPanel() {
  const t = useTranslations('Vault');
  const {
    data: overview,
    failed,
    reload,
  } = useVaultRead('/api/vault', parseVaultOverview);
  // Bumped after every write so the audit trail re-reads.
  const [auditVersion, setAuditVersion] = useState(0);
  const bumpAudit = useCallback(() => setAuditVersion((v) => v + 1), []);
  const changed = useCallback(async () => {
    bumpAudit();
    await reload();
  }, [bumpAudit, reload]);

  const holder = overview?.myRole ?? null;
  const configured = overview?.configured === true;

  return (
    <section className="animate-in fade-in-50 max-w-4xl space-y-6 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {failed ? (
        <p className="text-destructive text-sm" role="alert">
          {t('loadFailed')}
        </p>
      ) : !overview ? (
        <div
          className="bg-muted/50 h-40 w-full animate-pulse rounded-xl"
          aria-busy="true"
        />
      ) : (
        <>
          <StatusCard overview={overview} />
          {configured && overview.bootstrapAvailable ? (
            <SetupCard onDone={changed} />
          ) : null}
          {holder === null ? (
            <p className="text-muted-foreground flex gap-2 text-sm">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t('noRole')}
            </p>
          ) : (
            <>
              <RolesCard
                roles={overview.roles}
                canManage={configured && holder === 'super_admin'}
                onChanged={changed}
              />
              {configured ? (
                <div className="grid gap-6 md:grid-cols-2">
                  <RevealCard onDone={bumpAudit} />
                  <EraseCard onDone={bumpAudit} />
                </div>
              ) : null}
              <AuditCard key={auditVersion} />
            </>
          )}
        </>
      )}
    </section>
  );
}

function CardTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-foreground text-base font-semibold">{children}</h3>
  );
}

function StatusCard({ overview }: { overview: VaultOverviewView }) {
  const t = useTranslations('Vault.status');
  return (
    <Card>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{t('title')}</CardTitle>
          {overview.configured ? (
            <Badge variant="secondary">
              <CircleCheck aria-hidden />
              {t('configured')}
            </Badge>
          ) : (
            <Badge variant="destructive">{t('notConfigured')}</Badge>
          )}
        </div>
        {overview.configured ? (
          <p className="text-muted-foreground text-sm">{t('configuredBody')}</p>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              {t('notConfiguredBody')}
            </p>
            <p className="text-muted-foreground font-mono text-xs">
              {t('reasonCode', { code: overview.reason ?? 'UNAVAILABLE' })}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SetupCard({ onDone }: { onDone: () => Promise<void> }) {
  const t = useTranslations('Vault');
  const { isOwner } = useAuth();
  const errorText = useErrorText();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function bootstrap() {
    setConfirming(false);
    setBusy(true);
    const answer = await call('/api/vault/bootstrap', { method: 'POST' });
    setBusy(false);
    if (!answer.ok) {
      toast.error(errorText(answer));
      return;
    }
    toast.success(t('setup.done'));
    await onDone();
  }

  return (
    <Card>
      <CardContent className="space-y-3">
        <CardTitle>{t('setup.title')}</CardTitle>
        <p className="text-muted-foreground text-sm">{t('setup.body')}</p>
        {isOwner ? (
          <Button size="sm" disabled={busy} onClick={() => setConfirming(true)}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <KeyRound className="size-4" />
            )}
            {t('setup.become')}
          </Button>
        ) : (
          <p className="text-muted-foreground text-sm">
            {t('setup.ownerOnly')}
          </p>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('setup.confirmTitle')}
        description={t('setup.confirmBody')}
        cancelLabel={t('cancel')}
        confirmLabel={t('setup.confirm')}
        onConfirm={() => void bootstrap()}
      />
    </Card>
  );
}

function RolesCard({
  roles,
  canManage,
  onChanged,
}: {
  roles: VaultRoleView[];
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useTranslations('Vault.roles');
  const tv = useTranslations('Vault');
  const { user } = useAuth();
  const { members, name } = useNames();
  const when = useWhen();
  const errorText = useErrorText();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<VaultRoleView | null>(null);
  const [busy, setBusy] = useState(false);

  async function change(
    method: 'POST' | 'DELETE',
    userId: string,
    role: VaultRoleName
  ): Promise<boolean> {
    setBusy(true);
    const answer = await call('/api/vault/roles', {
      method,
      body: JSON.stringify({ user_id: userId, role }),
    });
    setBusy(false);
    if (!answer.ok) {
      toast.error(errorText(answer));
      return false;
    }
    const noop =
      (answer.body as { status?: unknown } | null)?.status === 'NOOP';
    toast.success(
      method === 'POST'
        ? t(noop ? 'alreadyHeld' : 'added')
        : t(noop ? 'alreadyGone' : 'removed')
    );
    await onChanged();
    return true;
  }

  async function remove() {
    const row = removing;
    setRemoving(null);
    if (row) await change('DELETE', row.userId, row.role);
  }

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{t('title')}</CardTitle>
          {canManage ? (
            <Button size="sm" disabled={busy} onClick={() => setAdding(true)}>
              <Plus className="size-4" />
              {t('add')}
            </Button>
          ) : null}
        </div>
        <p className="text-muted-foreground text-sm">{t('body')}</p>
        {roles.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">
            {t('empty')}
          </p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-lg border">
            {roles.map((r) => (
              <li
                key={`${r.userId}:${r.role}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-foreground truncate text-sm font-medium">
                      {name(r.userId)}
                      {r.userId === user?.id ? ` ${t('you')}` : ''}
                    </span>
                    <Badge
                      variant={r.role === 'super_admin' ? 'default' : 'outline'}
                    >
                      {t(`names.${r.role}`)}
                    </Badge>
                    {!r.counts ? (
                      <Badge variant="destructive">{t('notActive')}</Badge>
                    ) : null}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {r.grantedBy
                      ? t('grantedBy', {
                          name: name(r.grantedBy),
                          date: when(r.grantedAt),
                        })
                      : t('grantedOn', { date: when(r.grantedAt) })}
                  </p>
                </div>
                {canManage ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={t('removeLabel', {
                      name: name(r.userId),
                      role: t(`names.${r.role}`),
                    })}
                    onClick={() => setRemoving(r)}
                  >
                    <Trash2 className="size-4" />
                    {t('remove')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {adding ? (
        <AddRoleDialog
          candidates={members
            .filter(
              (m) =>
                !m.deactivated_at &&
                m.account_role &&
                hasMinRole(m.account_role, 'admin')
            )
            .map((m) => ({ userId: m.user_id, name: m.full_name || m.email }))}
          onClose={() => setAdding(false)}
          onAdd={(userId, role) => change('POST', userId, role)}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('removeTitle')}
        description={
          removing
            ? t('removeBody', {
                name: name(removing.userId),
                role: t(`names.${removing.role}`),
              })
            : ''
        }
        cancelLabel={tv('cancel')}
        confirmLabel={t('remove')}
        destructive
        onConfirm={() => void remove()}
      />
    </Card>
  );
}

function AddRoleDialog({
  candidates,
  onClose,
  onAdd,
}: {
  candidates: { userId: string; name: string }[];
  onClose: () => void;
  onAdd: (userId: string, role: VaultRoleName) => Promise<boolean>;
}) {
  const t = useTranslations('Vault.addRole');
  const tr = useTranslations('Vault.roles.names');
  const tv = useTranslations('Vault');
  const [userId, setUserId] = useState<string | null>(null);
  const [role, setRole] = useState<VaultRoleName>('admin');
  const [busy, setBusy] = useState(false);
  const picked = candidates.find((c) => c.userId === userId) ?? null;

  async function submit() {
    if (!picked) return;
    setBusy(true);
    const ok = await onAdd(picked.userId, role);
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('body')}</DialogDescription>
        </DialogHeader>
        {candidates.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noCandidates')}</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t('person')}</Label>
              <Select
                value={userId}
                onValueChange={(v) =>
                  setUserId(typeof v === 'string' ? v : null)
                }
              >
                <SelectTrigger className="w-full" aria-label={t('person')}>
                  <SelectValue>
                    {picked ? picked.name : t('personPlaceholder')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((c) => (
                    <SelectItem key={c.userId} value={c.userId}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('role')}</Label>
              <Select
                value={role}
                onValueChange={(v) => v && setRole(v as VaultRoleName)}
              >
                <SelectTrigger className="w-full" aria-label={t('role')}>
                  <SelectValue>{tr(role)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {VAULT_ROLE_NAMES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {tr(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                {t(role === 'super_admin' ? 'superHelp' : 'adminHelp')}
              </p>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {tv('cancel')}
          </Button>
          <Button disabled={busy || !picked} onClick={() => void submit()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Token + reason inputs, with the warnings shown before anything is sent. */
function useTokenAndReason() {
  const [token, setToken] = useState('');
  const [reason, setReason] = useState('');
  const cleanToken = token.trim();
  const tokenBad = cleanToken !== '' && !isVaultToken(cleanToken);
  const tooLong = [...reason].length > VAULT_REASON_MAX;
  const identifier = reasonLooksLikeIdentifier(reason);
  const ready =
    isVaultToken(cleanToken) && reason.trim() !== '' && !tooLong && !identifier;
  return {
    token,
    setToken,
    reason,
    setReason,
    cleanToken,
    tokenBad,
    tooLong,
    identifier,
    ready,
    clear: () => {
      setToken('');
      setReason('');
    },
  };
}

function TokenReasonFields({
  idPrefix,
  form,
}: {
  idPrefix: string;
  form: ReturnType<typeof useTokenAndReason>;
}) {
  const t = useTranslations('Vault.form');
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-token`}>{t('token')}</Label>
        <Input
          id={`${idPrefix}-token`}
          value={form.token}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          placeholder={t('tokenPlaceholder')}
          onChange={(e) => form.setToken(e.target.value)}
          aria-invalid={form.tokenBad || undefined}
        />
        {form.tokenBad ? (
          <p className="text-destructive text-xs" role="alert">
            {t('tokenInvalid')}
          </p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-reason`}>{t('reason')}</Label>
        <Textarea
          id={`${idPrefix}-reason`}
          value={form.reason}
          rows={2}
          placeholder={t('reasonPlaceholder')}
          onChange={(e) => form.setReason(e.target.value)}
          aria-invalid={form.tooLong || form.identifier || undefined}
        />
        {form.identifier ? (
          <p className="text-destructive text-xs" role="alert">
            {t('reasonIdentifier')}
          </p>
        ) : form.tooLong ? (
          <p className="text-destructive text-xs" role="alert">
            {t('reasonTooLong')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function RevealCard({ onDone }: { onDone: () => void }) {
  const t = useTranslations('Vault.reveal');
  const tErr = useTranslations('Vault.errors');
  const form = useTokenAndReason();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The value lives only here and only while the dialog is open:
  // `shown` is null once it closes, `value` null once the 30 s are up.
  const [shown, setShown] = useState<{
    seq: number;
    value: string | null;
  } | null>(null);

  async function reveal() {
    if (!form.ready) return;
    setBusy(true);
    setError(null);
    const answer = await requestReveal(form.cleanToken, form.reason);
    setBusy(false);
    onDone();
    if (answer.ok)
      setShown((s) => ({ seq: (s?.seq ?? 0) + 1, value: answer.value }));
    else setError(tErr(vaultErrorKey(answer.status, answer.code)));
  }

  return (
    <Card>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void reveal();
          }}
        >
          <CardTitle>{t('title')}</CardTitle>
          <p className="text-muted-foreground text-sm">{t('body')}</p>
          <TokenReasonFields idPrefix="vault-reveal" form={form} />
          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="sm" disabled={busy || !form.ready}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('submit')}
          </Button>
        </form>
      </CardContent>
      {shown ? (
        <Dialog open onOpenChange={(open) => !open && setShown(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('dialogTitle')}</DialogTitle>
              <DialogDescription>{t('dialogBody')}</DialogDescription>
            </DialogHeader>
            {shown.value !== null ? (
              <RevealedValue
                key={shown.seq}
                value={shown.value}
                onExpire={() =>
                  setShown((s) => (s ? { seq: s.seq, value: null } : s))
                }
              />
            ) : (
              <p className="text-muted-foreground text-sm" role="status">
                {t('hidden')}
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setShown(null)}>
                {t('close')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}

function EraseCard({ onDone }: { onDone: () => void }) {
  const t = useTranslations('Vault.erase');
  const tv = useTranslations('Vault');
  const errorText = useErrorText();
  const form = useTokenAndReason();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function erase() {
    setConfirming(false);
    if (!form.ready) return;
    setBusy(true);
    setError(null);
    const answer = await call('/api/vault/erase', {
      method: 'POST',
      body: JSON.stringify({ token: form.cleanToken, reason: form.reason }),
    });
    setBusy(false);
    onDone();
    if (!answer.ok) {
      setError(errorText(answer));
      return;
    }
    toast.success(t('done'));
    form.clear();
  }

  return (
    <Card>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.ready) setConfirming(true);
          }}
        >
          <CardTitle>{t('title')}</CardTitle>
          <p className="text-muted-foreground text-sm">{t('body')}</p>
          <TokenReasonFields idPrefix="vault-erase" form={form} />
          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            size="sm"
            variant="destructive"
            disabled={busy || !form.ready}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            {t('submit')}
          </Button>
        </form>
      </CardContent>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('confirmTitle')}
        description={t('confirmBody')}
        cancelLabel={tv('cancel')}
        confirmLabel={t('confirm')}
        destructive
        onConfirm={() => void erase()}
      />
    </Card>
  );
}

const KNOWN_ACTIONS = new Set([
  'put',
  'dedupe',
  'reveal',
  'reveal_failed',
  'delete',
  'rewrap_read',
  'rewrap',
  'role_grant',
  'role_revoke',
  'role_bootstrap',
]);
const KNOWN_OUTCOMES = new Set([
  'OK',
  'DENIED',
  'NOT_FOUND',
  'RATE_LIMITED',
  'CONFLICT',
  'DECRYPT_FAILED',
]);

function AuditCard() {
  const t = useTranslations('Vault.audit');
  const tr = useTranslations('Vault.roles.names');
  const { data: rows, failed } = useVaultRead(
    '/api/vault/audit?limit=100',
    parseAudit
  );
  const { name } = useNames();
  const when = useWhen();

  const action = (r: VaultAuditView) =>
    KNOWN_ACTIONS.has(r.action) ? t(`actions.${r.action}`) : r.action;
  const outcome = (r: VaultAuditView) =>
    KNOWN_OUTCOMES.has(r.outcome) ? t(`outcomes.${r.outcome}`) : r.outcome;

  return (
    <Card>
      <CardContent className="space-y-3">
        <CardTitle>{t('title')}</CardTitle>
        <p className="text-muted-foreground text-sm">{t('note')}</p>
        {failed ? (
          <p className="text-destructive text-sm" role="alert">
            {t('loadFailed')}
          </p>
        ) : !rows ? (
          <div
            className="bg-muted/50 h-24 w-full animate-pulse rounded-lg"
            aria-busy="true"
          />
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">
            {t('empty')}
          </p>
        ) : (
          <div className="-mx-1 overflow-x-auto px-1">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.time')}</TableHead>
                  <TableHead>{t('columns.who')}</TableHead>
                  <TableHead>{t('columns.action')}</TableHead>
                  <TableHead>{t('columns.outcome')}</TableHead>
                  <TableHead>{t('columns.token')}</TableHead>
                  <TableHead>{t('columns.kind')}</TableHead>
                  <TableHead>{t('columns.reason')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {when(r.at)}
                    </TableCell>
                    <TableCell className="text-xs">{name(r.actor)}</TableCell>
                    <TableCell className="text-xs">
                      <div>{action(r)}</div>
                      {r.targetUserId ? (
                        <div className="text-muted-foreground">
                          {r.targetRole
                            ? t('target', {
                                name: name(r.targetUserId),
                                role: tr(r.targetRole),
                              })
                            : name(r.targetUserId)}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">
                      <Badge
                        variant={
                          r.outcome === 'OK' ? 'secondary' : 'destructive'
                        }
                      >
                        {outcome(r)}
                      </Badge>
                      {r.why ? (
                        <div className="text-muted-foreground mt-0.5 font-mono text-[11px]">
                          {r.why}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      {r.token ?? '—'}
                    </TableCell>
                    <TableCell className="text-xs">{r.kind ?? '—'}</TableCell>
                    <TableCell className="max-w-[24ch] text-xs break-words whitespace-normal">
                      {r.reason ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
