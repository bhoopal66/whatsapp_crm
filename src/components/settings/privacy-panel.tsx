'use client';

/**
 * Settings → Privacy (PDPL, migrations 221-224), owners and admins:
 *  - a customer's request: export their data, place or release a legal
 *    hold, and erase (a dry run first; erasing needs the typed
 *    confirmation the server checks);
 *  - the retention policy (allow-listed kinds of data, days, delete or
 *    blank, dry run until applied);
 *  - the legal basis for sending customer text to AI providers abroad,
 *    and whether it is required.
 * Every rule is the server's; this only collects and shows.
 */
import { useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import {
  ContactPicker,
  type ContactOption,
} from '@/components/pipelines/contact-picker';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { RETENTION_RULES, type RetentionAction } from '@/lib/privacy/retention';
import type { RetentionLastRun } from '@/lib/privacy/store';

const FIELD =
  'border-input bg-card dark:bg-input/30 h-9 rounded-md border px-3 text-sm';

async function call<T>(
  url: string,
  init?: RequestInit
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, init);
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!res.ok)
      return {
        ok: false,
        error:
          typeof body.error === 'string' ? body.error : 'Something went wrong',
      };
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export function PrivacyPanel() {
  return (
    <div className="space-y-6">
      <CustomerRequest />
      <Retention />
      <AiTransfer />
    </div>
  );
}

// ---------- a customer's request ----------

interface EraseOut {
  mode: 'dry_run' | 'erase';
  blocked?: 'legal_hold' | null;
  counts?: Record<string, number>;
  files?: { deleted: number; remaining: number; total: number };
  retained: { table: string; reason: string }[];
}

function CustomerRequest() {
  const t = useTranslations('Privacy');
  const [contact, setContact] = useState<ContactOption | null>(null);
  const [hold, setHold] = useState<{
    onHold: boolean;
    reason: string | null;
  } | null>(null);
  // The read failed: say so, and offer neither Place nor Release.
  const [holdFailed, setHoldFailed] = useState(false);
  const [holdReason, setHoldReason] = useState('');
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [result, setResult] = useState<EraseOut | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  // Whose answer may still be shown: a preview of one customer must never
  // appear on (or be confirmed for) another.
  const currentId = useRef<string | null>(null);

  useEffect(() => {
    if (!contact) return;
    let alive = true;
    void call<{ onHold: boolean; reason: string | null }>(
      `/api/privacy/legal-hold?contactId=${contact.id}`
    ).then((r) => {
      if (!alive) return;
      if (r.ok) setHold(r.data);
      else setHoldFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [contact]);

  const pick = (c: ContactOption | null) => {
    // A request under way belongs to the customer on screen.
    if (busy) return;
    currentId.current = c?.id ?? null;
    setContact(c);
    setHold(null);
    setHoldFailed(false);
    setHoldReason('');
    setConfirmRelease(false);
    setResult(null);
    setConfirm('');
  };

  const exportData = async () => {
    if (!contact) return;
    setBusy(true);
    try {
      const res = await fetch(
        '/api/privacy/export',
        json('POST', { contactId: contact.id })
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Something went wrong');
        return;
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `customer-data-${contact.id}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success(t('request.exported'));
    } finally {
      setBusy(false);
    }
  };

  const setLegalHold = async (place: boolean) => {
    if (!contact) return;
    const forId = contact.id;
    setBusy(true);
    const r = await call<{ onHold: boolean; reason: string | null }>(
      '/api/privacy/legal-hold',
      json('POST', {
        contactId: contact.id,
        action: place ? 'place' : 'release',
        reason: holdReason,
      })
    );
    setBusy(false);
    setConfirmRelease(false);
    if (currentId.current !== forId) return;
    if (!r.ok) return void toast.error(r.error);
    setHold(r.data);
    setHoldReason('');
    // A preview made under the old hold no longer says what erasing does.
    setResult(null);
    setConfirm('');
  };

  const erase = async (dryRun: boolean) => {
    if (!contact) return;
    const forId = contact.id;
    setBusy(true);
    const r = await call<EraseOut>(
      '/api/privacy/erase',
      json('POST', {
        contactId: contact.id,
        dryRun,
        confirm: dryRun ? undefined : confirm,
      })
    );
    setBusy(false);
    if (currentId.current !== forId) return;
    if (!r.ok) return void toast.error(r.error);
    setResult(r.data);
    if (!dryRun && !r.data.blocked) {
      toast.success(t('request.erased'));
      setConfirm('');
    }
  };

  const confirmText = contact ? `ERASE ${contact.id}` : '';
  const counts = Object.entries(result?.counts ?? {}).filter(([, n]) => n > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('request.title')}</CardTitle>
        <CardDescription>{t('request.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ContactPicker
          selected={contact}
          onChange={pick}
          placeholder={t('request.pick')}
        />
        {contact && (
          <>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy} onClick={exportData}>
                {t('request.export')}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => erase(true)}
              >
                {t('request.dryRun')}
              </Button>
            </div>

            <div className="bg-card-2 space-y-2 rounded-md p-3 text-sm">
              <div className="font-medium">{t('hold.title')}</div>
              {hold?.onHold ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-warning">
                    {t('hold.on', { reason: hold.reason ?? '' })}
                  </span>
                  {confirmRelease ? (
                    <>
                      <span>{t('hold.releaseConfirm')}</span>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => setLegalHold(false)}
                      >
                        {t('hold.release')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setConfirmRelease(false)}
                      >
                        {t('hold.keep')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setConfirmRelease(true)}
                    >
                      {t('hold.release')}
                    </Button>
                  )}
                </div>
              ) : holdFailed ? (
                <p className="text-destructive" role="alert">
                  {t('hold.loadFailed')}
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="max-w-sm"
                    value={holdReason}
                    placeholder={t('hold.reason')}
                    onChange={(e) => setHoldReason(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || holdReason.trim() === ''}
                    onClick={() => setLegalHold(true)}
                  >
                    {t('hold.place')}
                  </Button>
                </div>
              )}
            </div>

            {result && (
              <div
                className="bg-card-2 space-y-3 rounded-md p-3 text-sm"
                role="status"
              >
                {result.blocked ? (
                  <p className="text-warning">{t('request.blocked')}</p>
                ) : (
                  <>
                    <p className="font-medium">
                      {result.mode === 'dry_run'
                        ? t('request.dryRunTitle')
                        : t('request.erasedTitle')}
                    </p>
                    {counts.length === 0 ? (
                      <p className="text-muted-foreground">
                        {t('request.nothing')}
                      </p>
                    ) : (
                      <ul className="grid gap-x-6 sm:grid-cols-2">
                        {counts.map(([table, n]) => (
                          <li
                            key={table}
                            className="flex justify-between gap-2"
                          >
                            <span className="font-mono text-xs">{table}</span>
                            <span>{n}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {result.files && result.files.remaining > 0 && (
                      <p className="text-warning">
                        {t('request.filesLeft', { n: result.files.remaining })}
                      </p>
                    )}
                    <details>
                      <summary className="cursor-pointer">
                        {t('request.retained', { n: result.retained.length })}
                      </summary>
                      <ul className="text-muted-foreground mt-2 space-y-1 text-xs">
                        {result.retained.map((r) => (
                          <li key={r.table}>
                            <span className="text-foreground font-mono">
                              {r.table}
                            </span>
                            : {r.reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                    {result.mode === 'dry_run' && (
                      <div className="space-y-2 border-t pt-3">
                        <Label htmlFor="privacy-confirm">
                          {t('request.confirmLabel', { text: confirmText })}
                        </Label>
                        <Input
                          id="privacy-confirm"
                          value={confirm}
                          onChange={(e) => setConfirm(e.target.value)}
                        />
                        <Button
                          variant="destructive"
                          disabled={busy || confirm !== confirmText}
                          onClick={() => erase(false)}
                        >
                          {t('request.erase')}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- retention ----------

type Row = { on: boolean; days: string; action: RetentionAction };

function Retention() {
  const t = useTranslations('Privacy');
  const format = useFormatter();
  const [rows, setRows] = useState<Record<string, Row> | null>(null);
  const [apply, setApply] = useState(false);
  const [lastRun, setLastRun] = useState<RetentionLastRun | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void call<{
      policy: {
        tables?: Record<string, { days: number; action: RetentionAction }>;
      };
      apply: boolean;
      lastRun: RetentionLastRun | null;
    }>('/api/privacy/retention').then((r) => {
      if (!r.ok) return void toast.error(r.error);
      const tables = r.data.policy?.tables ?? {};
      setRows(
        Object.fromEntries(
          Object.entries(RETENTION_RULES).map(([k, rule]) => [
            k,
            {
              on: k in tables,
              days: String(tables[k]?.days ?? 365),
              action: tables[k]?.action ?? rule.actions[0]!,
            },
          ])
        )
      );
      setApply(r.data.apply);
      setLastRun(r.data.lastRun ?? null);
    });
  }, []);

  const save = async () => {
    if (!rows) return;
    const tables = Object.fromEntries(
      Object.entries(rows)
        .filter(([, r]) => r.on)
        .map(([k, r]) => [k, { days: Number(r.days), action: r.action }])
    );
    setBusy(true);
    const r = await call(
      '/api/privacy/retention',
      json('PUT', { policy: { tables }, apply })
    );
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(t('retention.saved'));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('retention.title')}</CardTitle>
        <CardDescription>{t('retention.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows === null ? (
          <p className="text-muted-foreground text-sm">{t('loading')}</p>
        ) : (
          <>
            {Object.entries(RETENTION_RULES).map(([k, rule]) => {
              const r = rows[k]!;
              const set = (next: Partial<Row>) =>
                setRows({ ...rows, [k]: { ...r, ...next } });
              return (
                <div
                  key={k}
                  className="flex flex-wrap items-center gap-2 text-sm"
                >
                  <Switch
                    checked={r.on}
                    onCheckedChange={(v) => set({ on: v })}
                    aria-label={t(`retention.keys.${k}`)}
                  />
                  <span id={`retention-${k}`} className="min-w-56">
                    {t(`retention.keys.${k}`)}
                  </span>
                  <Input
                    className="w-24"
                    type="number"
                    min={30}
                    value={r.days}
                    disabled={!r.on}
                    aria-label={t('retention.days')}
                    onChange={(e) => set({ days: e.target.value })}
                  />
                  <span className="text-muted-foreground">
                    {t('retention.days')}
                  </span>
                  <select
                    className={FIELD}
                    aria-labelledby={`retention-${k}`}
                    value={r.action}
                    disabled={!r.on || rule.actions.length < 2}
                    onChange={(e) =>
                      set({ action: e.target.value as RetentionAction })
                    }
                  >
                    {rule.actions.map((a) => (
                      <option key={a} value={a}>
                        {t(`retention.actions.${a}`)}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
            <div className="flex items-center gap-2 border-t pt-3 text-sm">
              <Switch
                checked={apply}
                onCheckedChange={setApply}
                aria-label={t('retention.apply')}
              />
              <span>
                {apply ? t('retention.apply') : t('retention.dryRun')}
              </span>
            </div>
            {lastRun && (
              <p
                className={
                  lastRun.mode === 'failed'
                    ? 'text-destructive text-sm'
                    : 'text-muted-foreground text-sm'
                }
                role={lastRun.mode === 'failed' ? 'alert' : undefined}
              >
                {t(
                  lastRun.mode === 'failed'
                    ? 'retention.lastFailed'
                    : lastRun.mode === 'apply'
                      ? 'retention.lastApply'
                      : 'retention.lastDryRun',
                  {
                    at: format.dateTime(new Date(lastRun.at), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }),
                    rows: lastRun.rows,
                    files: lastRun.files,
                    code: lastRun.code || '-',
                  }
                )}
                {lastRun.more && ` ${t('retention.lastMore')}`}
              </p>
            )}
            <Button onClick={save} disabled={busy}>
              {t('save')}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- AI transfer basis ----------

interface AiOut {
  basis: {
    basis: string | null;
    note: string | null;
    approved_by: string | null;
    provider_region: string | null;
    require_basis: boolean;
  } | null;
  last_30_days: Record<string, number>;
  refused_30_days: number;
}

const BASES = ['consent', 'contract', 'adequacy', 'scc', 'other'] as const;

function AiTransfer() {
  const t = useTranslations('Privacy');
  const [data, setData] = useState<AiOut | null>(null);
  const [form, setForm] = useState({
    basis: '',
    note: '',
    approvedBy: '',
    region: '',
    requireBasis: false,
  });
  const [busy, setBusy] = useState(false);

  const apply = (d: AiOut) => {
    setData(d);
    setForm({
      basis: d.basis?.basis ?? '',
      note: d.basis?.note ?? '',
      approvedBy: d.basis?.approved_by ?? '',
      region: d.basis?.provider_region ?? '',
      requireBasis: d.basis?.require_basis ?? false,
    });
  };

  useEffect(() => {
    void call<AiOut>('/api/privacy/ai-transfer').then((r) => {
      if (r.ok) apply(r.data);
      else toast.error(r.error);
    });
  }, []);

  const save = async () => {
    setBusy(true);
    const r = await call<AiOut>(
      '/api/privacy/ai-transfer',
      json('PUT', { ...form, basis: form.basis || null })
    );
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    apply(r.data);
    toast.success(t('ai.saved'));
  };

  const complete =
    form.basis !== '' &&
    form.note.trim().length >= 20 &&
    form.approvedBy.trim() !== '' &&
    form.region.trim() !== '';
  const calls = Object.values(data?.last_30_days ?? {}).reduce(
    (a, b) => a + b,
    0
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('ai.title')}</CardTitle>
        <CardDescription>{t('ai.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ai-basis">{t('ai.basis')}</Label>
            <select
              id="ai-basis"
              className={`${FIELD} w-full`}
              value={form.basis}
              onChange={(e) => setForm({ ...form, basis: e.target.value })}
            >
              <option value="">{t('ai.none')}</option>
              {BASES.map((b) => (
                <option key={b} value={b}>
                  {t(`ai.bases.${b}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ai-region">{t('ai.region')}</Label>
            <Input
              id="ai-region"
              value={form.region}
              placeholder="US / EU"
              onChange={(e) => setForm({ ...form, region: e.target.value })}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ai-note">{t('ai.note')}</Label>
            <Textarea
              id="ai-note"
              rows={2}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ai-by">{t('ai.approvedBy')}</Label>
            <Input
              id="ai-by"
              value={form.approvedBy}
              onChange={(e) => setForm({ ...form, approvedBy: e.target.value })}
            />
          </div>
        </div>
        <div className="flex items-start gap-2 border-t pt-3 text-sm">
          <Switch
            checked={form.requireBasis}
            onCheckedChange={(v) => setForm({ ...form, requireBasis: v })}
            aria-label={t('ai.require')}
          />
          <div>
            <div>{t('ai.require')}</div>
            {form.requireBasis && !complete && (
              <p className="text-warning">{t('ai.requireIncomplete')}</p>
            )}
          </div>
        </div>
        {data && (
          <p className="text-muted-foreground text-sm">
            {t('ai.stats', { calls, refused: data.refused_30_days })}
          </p>
        )}
        <Button onClick={save} disabled={busy}>
          {t('save')}
        </Button>
      </CardContent>
    </Card>
  );
}
