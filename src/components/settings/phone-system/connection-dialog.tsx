'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Copy, Loader2 } from 'lucide-react';

import {
  PBX_EDITIONS,
  validateConnectionForm,
  type ConnectionDraft,
  type ConnectionField,
  type ConnectionIssue,
  type PbxConnectionView,
  type PbxEdition,
} from '@/lib/pbx/admin-ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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

import { pbxFetch } from './fetch';

const blank = (c: PbxConnectionView | null): ConnectionDraft => ({
  label: c?.label ?? 'Yeastar P-Series',
  edition: c?.edition ?? 'cloud',
  baseUrl: c?.baseUrl ?? '',
  clientId: '',
  clientSecret: '',
  sdkAccessId: '',
  sdkAccessKey: '',
  webhookSecret: '',
  clearSdk: false,
  clearWebhookSecret: false,
});

/** Mount with a fresh `key` per opening: the form starts from what is
 *  saved, and secrets are never prefilled. */
export function ConnectionDialog({
  open,
  onOpenChange,
  connection,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: PbxConnectionView | null;
  onSaved: (c: PbxConnectionView) => void;
}) {
  const t = useTranslations('Settings.phoneSystem.form');
  const tp = useTranslations('Settings.phoneSystem');
  const [d, setD] = useState(() => blank(connection));
  const [issues, setIssues] = useState<
    Partial<Record<ConnectionField, ConnectionIssue>>
  >({});
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof ConnectionDraft>(k: K, v: ConnectionDraft[K]) =>
    setD((prev) => ({ ...prev, [k]: v }));

  const save = async () => {
    const checked = validateConnectionForm(d, connection);
    if (!checked.ok) {
      setIssues(checked.issues);
      return;
    }
    setIssues({});
    setSaving(true);
    const res = await pbxFetch<{ connection: PbxConnectionView | null }>(
      '/api/pbx/connection',
      { method: 'PUT', body: checked.payload }
    );
    setSaving(false);
    if (res.ok && res.data.connection) {
      onSaved(res.data.connection);
      toast.success(t('saved'));
      onOpenChange(false);
    } else if (!res.ok) {
      toast.error(tp('saveFailed'), { description: res.error ?? undefined });
    }
  };

  const issue = (f: ConnectionField) =>
    issues[f] ? (
      <p className="text-destructive text-xs">{t(`issues.${issues[f]}`)}</p>
    ) : null;
  const secretHolder = (stored: boolean) =>
    stored ? t('secretKept') : undefined;

  const field = (
    id: keyof ConnectionDraft & string,
    label: string,
    extra?: {
      type?: string;
      placeholder?: string;
      disabled?: boolean;
      hint?: string;
    }
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={`pbx-${id}`}>{label}</Label>
      <Input
        id={`pbx-${id}`}
        type={extra?.type ?? 'text'}
        autoComplete="off"
        value={String(d[id])}
        placeholder={extra?.placeholder}
        disabled={extra?.disabled}
        onChange={(e) => set(id, e.target.value as never)}
      />
      {extra?.hint ? (
        <p className="text-muted-foreground text-xs">{extra.hint}</p>
      ) : null}
    </div>
  );

  const copy = async () => {
    if (!connection) return;
    try {
      await navigator.clipboard.writeText(connection.webhookUrl);
      toast.success(t('copied'));
    } catch {
      /* clipboard refused: the URL stays selectable */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {field('label', t('label'))}
          {issue('label')}
          <div className="space-y-1.5">
            <Label>{t('edition')}</Label>
            <Select
              value={d.edition}
              onValueChange={(v) => set('edition', v as PbxEdition)}
            >
              <SelectTrigger className="w-full" aria-label={t('edition')}>
                <SelectValue>{t(`editions.${d.edition}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PBX_EDITIONS.map((e) => (
                  <SelectItem key={e} value={e}>
                    {t(`editions.${e}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {field('baseUrl', t('baseUrl'), {
            type: 'url',
            placeholder: 'https://pbx.example.com',
          })}
          {issue('baseUrl')}
          {field('clientId', t('clientId'), {
            placeholder: connection?.clientIdLast4
              ? `••••${connection.clientIdLast4}`
              : undefined,
            hint: connection ? t('clientIdHint') : undefined,
          })}
          {issue('clientId')}
          {field('clientSecret', t('clientSecret'), {
            type: 'password',
            placeholder: secretHolder(!!connection?.hasClientSecret),
          })}
          {issue('clientSecret')}
          {field('sdkAccessId', t('sdkAccessId'), {
            placeholder: secretHolder(!!connection?.hasSdkCredentials),
            disabled: d.clearSdk,
          })}
          {field('sdkAccessKey', t('sdkAccessKey'), {
            type: 'password',
            placeholder: secretHolder(!!connection?.hasSdkCredentials),
            disabled: d.clearSdk,
          })}
          {issue('sdk')}
          {connection?.hasSdkCredentials ? (
            <CheckRow
              checked={d.clearSdk}
              onChange={(v) => set('clearSdk', v)}
              label={t('removeSdk')}
            />
          ) : null}
          {field('webhookSecret', t('webhookSecret'), {
            type: 'password',
            placeholder: secretHolder(!!connection?.hasWebhookSecret),
            disabled: d.clearWebhookSecret,
          })}
          {issue('webhookSecret')}
          {connection?.hasWebhookSecret ? (
            <CheckRow
              checked={d.clearWebhookSecret}
              onChange={(v) => set('clearWebhookSecret', v)}
              label={t('removeWebhookSecret')}
            />
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="pbx-webhook-url">{t('webhookUrl')}</Label>
            {connection ? (
              <div className="flex gap-2">
                <Input
                  id="pbx-webhook-url"
                  readOnly
                  value={connection.webhookUrl}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={copy}
                  aria-label={t('copy')}
                >
                  <Copy />
                  <span className="hidden sm:inline">{t('copy')}</span>
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                {t('webhookUrlAfterSave')}
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CheckRow({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-sm">
      <Checkbox
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
      />
      <span>{label}</span>
    </label>
  );
}
