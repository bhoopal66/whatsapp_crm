'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Archive, Eraser, Landmark, Loader2, Plus, Trash2 } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import {
  guestsOnPatch,
  localDay,
  normaliseBankCode,
} from '@/lib/audit/consent';
import { confirmationMatches, reasonOk } from '@/lib/chat/admin-tools';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

import { SettingsPanelHead } from './settings-panel-head';

interface Policy {
  bank_code: string;
  guests_allowed: boolean;
  recording_allowed: boolean;
  dsa_checked_by: string | null;
  dsa_checked_at: string | null;
  note: string | null;
}

const COLUMNS =
  'bank_code, guests_allowed, recording_allowed, dsa_checked_by, dsa_checked_at, note';

/**
 * Settings → Consent and retention (admin+): the per-bank guest and
 * recording policy, the retention summary and (owner only) the erasure
 * of a customer's call recordings. RLS and the RPC enforce every rule.
 */
export function ConsentRetentionPanel() {
  const t = useTranslations('Settings.consentRetention');
  const { isOwner } = useAuth();
  return (
    <section className="animate-in fade-in-50 max-w-4xl space-y-6 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <BankPoliciesCard />
      <RetentionCard />
      {isOwner && <EraseRecordingsCard />}
    </section>
  );
}

function BankPoliciesCard() {
  const t = useTranslations('Settings.consentRetention.banks');
  const format = useFormatter();
  const { accountId } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Policy[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [allowing, setAllowing] = useState<string | null>(null);

  const fetchRows = useCallback(
    () =>
      supabase
        .from('bank_guest_policies')
        .select(COLUMNS)
        .eq('account_id', accountId ?? '')
        .order('bank_code'),
    [accountId, supabase]
  );
  const show = useCallback((res: { data: unknown; error: unknown }) => {
    setFailed(!!res.error);
    setRows(res.error ? [] : ((res.data as Policy[] | null) ?? []));
  }, []);

  useEffect(() => {
    if (!accountId) return;
    let off = false;
    fetchRows().then((res) => {
      if (!off) show(res);
    });
    fetch('/api/account/members')
      .then((res) => res.json())
      .then((json: { members?: { user_id: string; full_name: string }[] }) => {
        if (!off)
          setNames(
            new Map((json.members ?? []).map((m) => [m.user_id, m.full_name]))
          );
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [accountId, fetchRows, show]);

  async function save(
    bank: string,
    run: () => PromiseLike<{ error: unknown }>
  ) {
    setBusy(bank);
    const { error } = await run();
    if (error) toast.error(t('saveFailed'));
    show(await fetchRows());
    setBusy(null);
  }

  const table = () => supabase.from('bank_guest_policies');
  const normalised = normaliseBankCode(code);
  const exists =
    !!normalised && !!rows?.some((r) => r.bank_code === normalised);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <Landmark className="size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows === null ? (
          <p className="text-muted-foreground text-sm">{t('loading')}</p>
        ) : failed ? (
          <p className="text-destructive text-sm">{t('loadFailed')}</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('empty')}</p>
        ) : (
          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/50 text-muted-foreground text-left text-xs">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('bank')}</th>
                  <th className="px-3 py-2 font-medium">{t('guests')}</th>
                  <th className="px-3 py-2 font-medium">{t('recording')}</th>
                  <th className="px-3 py-2 font-medium">{t('checked')}</th>
                  <th className="px-3 py-2 font-medium">{t('note')}</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.bank_code} className="border-border border-t">
                    <td className="text-foreground px-3 py-2 font-medium">
                      {r.bank_code}
                    </td>
                    <td className="px-3 py-2">
                      <Switch
                        checked={r.guests_allowed}
                        disabled={busy === r.bank_code}
                        aria-label={`${t('guests')}: ${r.bank_code}`}
                        onCheckedChange={(on) =>
                          on
                            ? setAllowing(r.bank_code)
                            : void save(r.bank_code, () =>
                                table()
                                  .update({ guests_allowed: false })
                                  .eq('account_id', accountId!)
                                  .eq('bank_code', r.bank_code)
                              )
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Switch
                        checked={r.recording_allowed}
                        disabled={busy === r.bank_code}
                        aria-label={`${t('recording')}: ${r.bank_code}`}
                        onCheckedChange={(on) =>
                          void save(r.bank_code, () =>
                            table()
                              .update({ recording_allowed: on })
                              .eq('account_id', accountId!)
                              .eq('bank_code', r.bank_code)
                          )
                        }
                      />
                    </td>
                    <td className="text-muted-foreground px-3 py-2">
                      {r.dsa_checked_at
                        ? t('checkedBy', {
                            date: format.dateTime(new Date(r.dsa_checked_at), {
                              dateStyle: 'medium',
                            }),
                            name:
                              (r.dsa_checked_by &&
                                names.get(r.dsa_checked_by)) ||
                              '—',
                          })
                        : t('notChecked')}
                    </td>
                    <td className="text-muted-foreground max-w-[16rem] px-3 py-2 break-words">
                      {r.note || '—'}
                    </td>
                    <td className="px-2 py-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('remove', { bank: r.bank_code })}
                        disabled={busy === r.bank_code}
                        onClick={() =>
                          void save(r.bank_code, () =>
                            table()
                              .delete()
                              .eq('account_id', accountId!)
                              .eq('bank_code', r.bank_code)
                          )
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form
          className="flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!normalised || exists || !accountId) return;
            void save(normalised, () =>
              table().insert({ account_id: accountId, bank_code: normalised })
            ).then(() => setCode(''));
          }}
        >
          <div className="grid gap-1">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t('addPlaceholder')}
              aria-label={t('add')}
              className="w-56"
              maxLength={32}
            />
            {code.trim() && !normalised && (
              <p className="text-destructive text-xs">{t('invalidCode')}</p>
            )}
            {exists && (
              <p className="text-destructive text-xs">
                {t('exists', { bank: normalised })}
              </p>
            )}
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={!normalised || exists || !!busy}
          >
            <Plus className="size-4" />
            {t('add')}
          </Button>
        </form>
      </CardContent>
      {allowing && (
        <AllowGuestsDialog
          bank={allowing}
          onClose={() => setAllowing(null)}
          onAllow={async (patch) => {
            setAllowing(null);
            await save(allowing, () =>
              table()
                .update(patch)
                .eq('account_id', accountId!)
                .eq('bank_code', allowing)
            );
          }}
        />
      )}
    </Card>
  );
}

function AllowGuestsDialog({
  bank,
  onClose,
  onAllow,
}: {
  bank: string;
  onClose: () => void;
  onAllow: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const t = useTranslations('Settings.consentRetention.banks');
  const [day, setDay] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const { data } = await createClient().auth.getUser();
    if (!data.user) return;
    const result = guestsOnPatch({
      checkedOn: day,
      note,
      userId: data.user.id,
      today: localDay(new Date()),
    });
    if (!result.ok) {
      setError(t(result.error));
      return;
    }
    await onAllow(result.patch);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('dialogTitle', { bank })}</DialogTitle>
          <DialogDescription>{t('dialogDesc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="dsa-checked-on">{t('dateLabel')}</Label>
            <Input
              id="dsa-checked-on"
              type="date"
              required
              value={day}
              max={localDay(new Date())}
              onChange={(e) => setDay(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="dsa-note">{t('noteLabel')}</Label>
            <Textarea
              id="dsa-note"
              rows={2}
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!day}>
            {t('allow')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RetentionCard() {
  const t = useTranslations('Settings.consentRetention.retention');
  // undefined while loading; null keeps recordings (089's default).
  const [days, setDays] = useState<number | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    fetch('/api/pbx/settings', { cache: 'no-store' })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error();
        const v = json?.settings?.retentionDays;
        setDays(typeof v === 'number' ? v : null);
      })
      .catch(() => setFailed(true));
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <Archive className="size-4" />
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-muted-foreground space-y-2 text-sm">
        <p>{t('chats')}</p>
        <p>
          {failed || days === undefined
            ? t('recordingsUnknown')
            : days === null
              ? t('recordingsKept')
              : t('recordingsDays', { days })}{' '}
          <Link
            href="/settings?tab=phone-system"
            className="text-primary underline-offset-4 hover:underline"
          >
            {t('openPhone')}
          </Link>
        </p>
        <p>
          {t('erasure')}{' '}
          <Link
            href="/settings?tab=team-chat"
            className="text-primary underline-offset-4 hover:underline"
          >
            {t('openTeamChat')}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

const ERASE_ERRORS: Record<number, 'forbidden' | 'notFound' | 'legalHold'> = {
  403: 'forbidden',
  404: 'notFound',
  409: 'legalHold',
};

function EraseRecordingsCard() {
  const t = useTranslations('Settings.consentRetention.erase');
  const [contact, setContact] = useState<ContactOption | null>(null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [erasing, setErasing] = useState(false);
  const [result, setResult] = useState<{
    name: string;
    deleted: number;
    failed: number;
  } | null>(null);

  // What to type: their name, else their phone, else the word ERASE.
  const word = contact
    ? contact.name?.trim() || contact.phone?.trim() || 'ERASE'
    : '';
  const ready =
    !!contact && reasonOk(reason) && confirmationMatches(typed, word);

  async function erase() {
    if (!contact || !ready) return;
    setErasing(true);
    try {
      const res = await fetch('/api/pbx/erase-contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: contact.id, reason: reason.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(t(ERASE_ERRORS[res.status] ?? 'failed'));
        return;
      }
      setResult({
        name: word,
        deleted: Number(json.deleted) || 0,
        failed: Number(json.failed) || 0,
      });
      setContact(null);
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
          <Label>{t('contactLabel')}</Label>
          <ContactPicker
            selected={contact}
            onChange={(c) => {
              setContact(c);
              setTyped('');
            }}
            placeholder={t('contactPlaceholder')}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="erase-recordings-reason">{t('reasonLabel')}</Label>
          <Textarea
            id="erase-recordings-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('reasonPlaceholder')}
            rows={2}
            maxLength={500}
            disabled={erasing}
          />
        </div>
        {contact && (
          <div className="grid gap-2 sm:max-w-sm">
            <Label htmlFor="erase-recordings-confirm">
              {t('confirmLabel', { word })}
            </Label>
            <Input
              id="erase-recordings-confirm"
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
              {t('summary', { count: result.deleted })}
            </p>
            {result.failed > 0 && (
              <p className="text-destructive">
                {t('filesFailed', { count: result.failed })}
              </p>
            )}
          </div>
        )}
        <Link
          href="/settings?tab=team-chat"
          className="text-primary block text-xs underline-offset-4 hover:underline"
        >
          {t('teamChatHint')}
        </Link>
      </CardContent>
    </Card>
  );
}
