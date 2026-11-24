'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Copy, Loader2, RefreshCw } from 'lucide-react';

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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { parseAllowedOrigins } from '@/lib/web-form/origin';
import {
  hostedFormUrl,
  htmlFormSnippet,
  iframeSnippet,
} from '@/lib/web-form/snippet';

import { SettingsPanelHead } from './settings-panel-head';

interface FormState {
  enabled: boolean;
  token: string | null;
  allowed_origins: string[];
}

/**
 * Settings → Integrations → Web form (owner/admin, migration 249,
 * docs/web-form.md): the public lead form's switch (off by default), its
 * link, a script-free HTML snippet and an iframe snippet, the websites
 * allowed to post it or frame it, and rotating its address. Reads and saves through /api/web-form, whose
 * RPCs check the role again and generate the token.
 */
export function WebFormPanel() {
  const t = useTranslations('Settings.webForm');
  const [saved, setSaved] = useState<FormState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [originsText, setOriginsText] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [siteUrl, setSiteUrl] = useState(
    process.env.NEXT_PUBLIC_SITE_URL ?? ''
  );

  useEffect(() => {
    if (!siteUrl && typeof window !== 'undefined') {
      setSiteUrl(window.location.origin);
    }
  }, [siteUrl]);

  const [loadTry, setLoadTry] = useState(0);

  useEffect(() => {
    let live = true;
    fetch('/api/web-form', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as FormState;
        if (!live) return;
        setSaved(data);
        setEnabled(data.enabled);
        setOriginsText((data.allowed_origins ?? []).join('\n'));
      })
      .catch(() => {
        if (live) setLoadFailed(true);
      });
    return () => {
      live = false;
    };
  }, [loadTry]);

  const parsed = parseAllowedOrigins(originsText);

  async function save(rotate: boolean) {
    if (saving || parsed.invalid.length > 0) return;
    setSaving(true);
    try {
      const res = await fetch('/api/web-form', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // Only what this click means: a rotate sends no switch or origins
        // (a stale tab would write its old ones back), a save sends just
        // the fields that changed. The route fills the rest from the row.
        body: JSON.stringify(
          rotate
            ? { rotate: true }
            : {
                ...(saved && enabled !== saved.enabled ? { enabled } : {}),
                ...(saved &&
                parsed.origins.join('\n') !== saved.allowed_origins.join('\n')
                  ? { allowedOrigins: parsed.origins }
                  : {}),
              }
        ),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as FormState;
      setSaved(data);
      setEnabled(data.enabled);
      setOriginsText((data.allowed_origins ?? []).join('\n'));
      toast.success(rotate ? t('rotated') : t('saved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
      setConfirmRotate(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  if (loadFailed) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-destructive text-sm">{t('loadFailed')}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setLoadFailed(false);
            setLoadTry((n) => n + 1);
          }}
        >
          {t('retry')}
        </Button>
      </div>
    );
  }
  if (!saved) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" />
        {t('loading')}
      </p>
    );
  }

  const link = saved.token ? hostedFormUrl(siteUrl, saved.token) : null;
  const snippet = saved.token ? htmlFormSnippet(siteUrl, saved.token) : null;
  const frame = saved.token ? iframeSnippet(siteUrl, saved.token) : null;
  const dirty =
    enabled !== saved.enabled ||
    parsed.origins.join('\n') !== saved.allowed_origins.join('\n');

  return (
    <section className="animate-in fade-in-50 max-w-2xl space-y-4 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Card>
        <CardContent className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p id="web-form-enabled-label" className="text-sm font-medium">
                {t('enabledLabel')}
              </p>
              <p className="text-muted-foreground text-xs">
                {enabled ? t('enabledOn') : t('enabledOff')}
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={(v) => setEnabled(v)}
              disabled={saving}
              aria-labelledby="web-form-enabled-label"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="web-form-origins">{t('originsLabel')}</Label>
            <Textarea
              id="web-form-origins"
              value={originsText}
              rows={3}
              placeholder="https://www.example.com"
              onChange={(e) => setOriginsText(e.target.value)}
              aria-invalid={parsed.invalid.length > 0}
            />
            <p
              className={
                parsed.invalid.length > 0
                  ? 'text-destructive text-xs'
                  : 'text-muted-foreground text-xs'
              }
            >
              {parsed.invalid.length > 0
                ? t('originsInvalid', { line: parsed.invalid[0] })
                : t('originsHint')}
            </p>
          </div>

          <Button
            onClick={() => void save(false)}
            disabled={saving || !dirty || parsed.invalid.length > 0}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {saving ? t('saving') : t('save')}
          </Button>
        </CardContent>
      </Card>

      {link && snippet && frame ? (
        <Card>
          <CardContent className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="web-form-link">{t('linkLabel')}</Label>
              <div className="flex gap-2">
                <Input id="web-form-link" value={link} readOnly />
                <Button
                  variant="outline"
                  onClick={() => void copy(link)}
                  aria-label={t('copyLink')}
                >
                  <Copy className="size-4" />
                  <span className="hidden sm:inline">{t('copy')}</span>
                </Button>
              </div>
              {!saved.enabled ? (
                <p className="text-muted-foreground text-xs">
                  {t('linkOffHint')}
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="web-form-snippet">{t('snippetLabel')}</Label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void copy(snippet)}
                >
                  <Copy className="size-4" />
                  {t('copySnippet')}
                </Button>
              </div>
              <Textarea
                id="web-form-snippet"
                value={snippet}
                readOnly
                rows={8}
                className="font-mono text-xs"
              />
              <p className="text-muted-foreground text-xs">
                {t('snippetHint')}
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="web-form-iframe">{t('iframeLabel')}</Label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void copy(frame)}
                >
                  <Copy className="size-4" />
                  {t('copyIframe')}
                </Button>
              </div>
              <Textarea
                id="web-form-iframe"
                value={frame}
                readOnly
                rows={3}
                className="font-mono text-xs"
              />
              <p className="text-muted-foreground text-xs">{t('iframeHint')}</p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-muted-foreground text-xs">{t('rotateHint')}</p>
              <Button
                variant="outline"
                onClick={() => setConfirmRotate(true)}
                disabled={saving}
              >
                <RefreshCw className="size-4" />
                {t('rotate')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <p className="text-muted-foreground text-sm">{t('noLinkYet')}</p>
      )}

      <Dialog open={confirmRotate} onOpenChange={setConfirmRotate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('rotateTitle')}</DialogTitle>
            <DialogDescription>{t('rotateBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRotate(false)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void save(true)}
              disabled={saving || parsed.invalid.length > 0}
            >
              {t('rotateConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
