'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { reasonKey } from '@/lib/groups/group-page';
import { ICON_MAX_BYTES, ICON_TYPES } from '@/lib/groups/limits';
import {
  GROUP_DESCRIPTION_MAX,
  GROUP_NAME_MAX,
  nameLength,
} from '@/lib/groups/ui';
import {
  GROUP_SETTINGS,
  type GroupPolicy,
  type GroupSetting,
} from '@/lib/groups/types';

import type { GroupTabProps } from '../group-page';

/** The Settings tab: name, description, picture and the four policies. */
export function SettingsTab({ groupId, detail, reload }: GroupTabProps) {
  const t = useTranslations('Groups.page');
  const s = useTranslations('Groups.page.settingsTab');
  const c = useTranslations('Groups.create');
  const { group } = detail;
  const url = `/api/whatsapp/groups/${groupId}`;

  const infoBlock = detail.blocks.edit_info;
  const settingsBlock = detail.blocks.settings;
  const reasonOf = (code: string) => t(`reasons.${reasonKey(code)}`);

  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? '');
  const [saving, setSaving] = useState(false);
  const [policies, setPolicies] = useState<
    Partial<Record<GroupSetting, GroupPolicy>>
  >({});
  const [pending, setPending] = useState<Set<GroupSetting>>(new Set());
  const [iconBusy, setIconBusy] = useState(false);
  const [iconVersion, setIconVersion] = useState(0);
  const [iconMissing, setIconMissing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const dirty =
    name.trim() !== group.name ||
    description.trim() !== (group.description ?? '');
  const nameLen = nameLength(name);
  const valid =
    nameLen > 0 &&
    nameLen <= GROUP_NAME_MAX &&
    description.length <= GROUP_DESCRIPTION_MAX;

  const failed = async (res: Response) => {
    const body = (await res.json().catch(() => null)) as {
      code?: string;
    } | null;
    toast.error(t(`reasons.${reasonKey(body?.code)}`));
  };

  const patch = async (body: unknown) =>
    fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const saveInfo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || !valid || saving) return;
    setSaving(true);
    try {
      const body: { name?: string; description?: string } = {};
      if (name.trim() !== group.name) body.name = name.trim();
      if (description.trim() !== (group.description ?? '')) {
        body.description = description.trim();
      }
      const res = await patch(body);
      if (!res.ok) return await failed(res);
      toast.success(s('toastSaved'));
      await reload();
    } catch {
      toast.error(t('reasons.unknown'));
    } finally {
      setSaving(false);
    }
  };

  const policyOf = (key: GroupSetting): GroupPolicy =>
    policies[key] ?? group.settings[key] ?? 'anyone';

  const togglePolicy = async (key: GroupSetting, on: boolean) => {
    const next: GroupPolicy = on ? 'admins' : 'anyone';
    const before = policyOf(key);
    setPolicies((p) => ({ ...p, [key]: next }));
    setPending((p) => new Set(p).add(key));
    try {
      const res = await patch({ settings: { [key]: next } });
      if (!res.ok) {
        setPolicies((p) => ({ ...p, [key]: before }));
        return await failed(res);
      }
      await reload();
      setPolicies((p) => {
        const rest = { ...p };
        delete rest[key];
        return rest;
      });
    } catch {
      setPolicies((p) => ({ ...p, [key]: before }));
      toast.error(t('reasons.unknown'));
    } finally {
      setPending((p) => {
        const n = new Set(p);
        n.delete(key);
        return n;
      });
    }
  };

  const upload = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (!(ICON_TYPES as readonly string[]).includes(file.type)) {
      toast.error(s('iconType'));
      return;
    }
    if (file.size > ICON_MAX_BYTES) {
      toast.error(t('reasons.too_large'));
      return;
    }
    setIconBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${url}/icon`, { method: 'PUT', body: form });
      if (!res.ok) return await failed(res);
      toast.success(s('toastIconSaved'));
      setIconMissing(false);
      setIconVersion((v) => v + 1);
      await reload();
    } catch {
      toast.error(t('reasons.unknown'));
    } finally {
      setIconBusy(false);
    }
  };

  const removeIcon = async () => {
    setIconBusy(true);
    try {
      const res = await fetch(`${url}/icon`, { method: 'DELETE' });
      if (!res.ok) return await failed(res);
      toast.success(s('toastIconRemoved'));
      setIconMissing(true);
      setIconVersion((v) => v + 1);
      await reload();
    } catch {
      toast.error(t('reasons.unknown'));
    } finally {
      setIconBusy(false);
    }
  };

  const infoLocked = !!infoBlock;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 overflow-y-auto pb-6">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{s('pictureTitle')}</h2>
        <div className="flex flex-wrap items-center gap-3">
          <div className="bg-muted text-muted-foreground flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-full">
            {iconMissing ? (
              <ImagePlus className="size-6" aria-hidden />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={iconVersion}
                src={`${url}/icon?v=${iconVersion}`}
                alt={s('pictureAlt')}
                className="size-full object-cover"
                onError={() => setIconMissing(true)}
              />
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileRef}
              type="file"
              accept={ICON_TYPES.join(',')}
              className="hidden"
              aria-label={s('upload')}
              onChange={(e) => void upload(e.target.files?.[0])}
            />
            <Button
              type="button"
              variant="outline"
              disabled={infoLocked || iconBusy}
              onClick={() => fileRef.current?.click()}
            >
              {iconBusy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ImagePlus className="size-4" />
              )}
              {s('upload')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={infoLocked || iconBusy || iconMissing}
              onClick={() => void removeIcon()}
            >
              <Trash2 className="size-4" />
              {s('remove')}
            </Button>
          </div>
        </div>
        <p className="text-muted-foreground text-xs">{s('pictureHint')}</p>
      </section>

      <form onSubmit={saveInfo} className="space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="group-settings-name">{c('name')}</Label>
            <span
              className={
                nameLen > GROUP_NAME_MAX
                  ? 'text-destructive text-xs tabular-nums'
                  : 'text-muted-foreground text-xs tabular-nums'
              }
            >
              {c('nameCounter', { count: nameLen, max: GROUP_NAME_MAX })}
            </span>
          </div>
          <Input
            id="group-settings-name"
            value={name}
            disabled={infoLocked}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="group-settings-description">
              {c('description')}
            </Label>
            <span className="text-muted-foreground text-xs tabular-nums">
              {c('nameCounter', {
                count: description.length,
                max: GROUP_DESCRIPTION_MAX,
              })}
            </span>
          </div>
          <Textarea
            id="group-settings-description"
            rows={4}
            maxLength={GROUP_DESCRIPTION_MAX}
            value={description}
            disabled={infoLocked}
            placeholder={c('descriptionPlaceholder')}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        {infoBlock && (
          <p className="text-muted-foreground text-xs">
            {s('blockedHint', { reason: reasonOf(infoBlock) })}
          </p>
        )}
        <Button
          type="submit"
          disabled={infoLocked || !dirty || !valid || saving}
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          {saving ? s('saving') : s('save')}
        </Button>
      </form>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{s('policiesTitle')}</h2>
        {settingsBlock && (
          <p className="text-muted-foreground text-xs">
            {s('blockedHint', { reason: reasonOf(settingsBlock) })}
          </p>
        )}
        <ul className="divide-border border-border divide-y rounded-lg border">
          {GROUP_SETTINGS.map((key) => (
            <li key={key} className="flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <Label htmlFor={`group-policy-${key}`}>
                  {c(`toggles.${key}`)}
                </Label>
                <p className="text-muted-foreground text-xs">
                  {c(`toggleHints.${key}`)}
                </p>
              </div>
              <Switch
                id={`group-policy-${key}`}
                checked={policyOf(key) === 'admins'}
                disabled={!!settingsBlock || pending.has(key)}
                onCheckedChange={(on) => void togglePolicy(key, on)}
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
