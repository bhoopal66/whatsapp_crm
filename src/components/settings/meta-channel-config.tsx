'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Eye,
  EyeOff,
  Copy,
  ExternalLink,
  ArrowRight,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * Connect a Meta WhatsApp Cloud API number alongside the Whapi channel.
 *
 * The panel leads with the constraint that surprises people: this has
 * to be a DIFFERENT phone number. A Whapi channel pairs to a number
 * that still lives in the WhatsApp app; registering a number on the
 * Cloud API removes it from the app. Nobody discovers that happily
 * after moving their main line.
 *
 * Unlike the Whapi panel (one token, webhook written over the API),
 * Meta needs several values and its webhook is configured by hand in
 * the App dashboard — so the callback URL is shown here to copy.
 */

const MASKED = '••••••••••••••••';

interface MetaChannelState {
  connected: boolean;
  phone_number_id?: string;
  waba_id?: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  status?: string;
  subscribed: boolean;
  label?: string | null;
  is_primary?: boolean;
}

export function MetaChannelConfig() {
  const t = useTranslations('Settings.whatsappMeta');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [state, setState] = useState<MetaChannelState | null>(null);

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/meta/webhook`
      : '/api/whatsapp/meta/webhook';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/config/meta');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('loadFailed'));
      setState(data);
      if (data.connected) {
        setPhoneNumberId(data.phone_number_id ?? '');
        setWabaId(data.waba_id ?? '');
        // Never round-trips the real token — a masked placeholder that
        // is only replaced if the admin actually types a new one.
        setAccessToken(MASKED);
        setTokenEdited(false);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    if (!phoneNumberId.trim()) {
      toast.error(t('phoneNumberIdRequired'));
      return;
    }
    if (!tokenEdited && !state?.connected) {
      toast.error(t('accessTokenRequired'));
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/config/meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone_number_id: phoneNumberId.trim(),
          waba_id: wabaId.trim(),
          // Omitted when untouched: the field shows a mask, never the
          // real token, and the API reuses the stored one rather than
          // treating an empty string as "clear it".
          access_token: tokenEdited ? accessToken.trim() : undefined,
          app_secret: appSecret.trim() || undefined,
          verify_token: verifyToken.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('saveFailed'));

      if (data.subscribe_error) {
        toast.warning(t('subscribeWarning'));
      } else {
        toast.success(t('saved'));
      }
      setAppSecret('');
      setVerifyToken('');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  /** Removing the number is owned by Numbers and access, for both
   *  providers; this card keeps the credentials, webhook and quality.
   *  Same History-API switch as the settings rail (settings/page.tsx). */
  const openNumbersAccess = () => {
    const params = new URLSearchParams(window.location.search);
    params.set('tab', 'numbers');
    params.delete('channel');
    window.history.replaceState(null, '', `/settings?${params.toString()}`);
  };

  const copyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      toast.success(t('webhookCopied'));
    } catch {
      toast.error(t('webhookCopyFailed'));
    }
  };

  if (loading) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="text-muted-foreground flex items-center gap-2 py-8">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('loading')}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          {t('title')}
          {state?.connected ? (
            <Badge className="gap-1">
              <CheckCircle2 className="h-3 w-3" />
              {t('connected')}
            </Badge>
          ) : (
            <Badge variant="secondary" className="gap-1">
              <XCircle className="h-3 w-3" />
              {t('notConnected')}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* The thing people get wrong. Shown always, not just on error. */}
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t('differentNumberTitle')}</AlertTitle>
          <AlertDescription>{t('differentNumberBody')}</AlertDescription>
        </Alert>

        {state?.connected && !state.subscribed && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t('notSubscribedTitle')}</AlertTitle>
            <AlertDescription>{t('notSubscribedBody')}</AlertDescription>
          </Alert>
        )}

        {state?.connected && state.display_phone_number && (
          <div className="border-border rounded-md border px-3 py-2 text-sm">
            <p className="text-foreground">
              {state.verified_name || t('unverifiedName')} ·{' '}
              {state.display_phone_number}
            </p>
            {state.quality_rating && (
              <p className="text-muted-foreground text-xs">
                {t('qualityRating', { rating: state.quality_rating })}
              </p>
            )}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="meta-pnid">{t('phoneNumberId')}</Label>
            <Input
              id="meta-pnid"
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value)}
              placeholder="109876543210"
            />
            <p className="text-muted-foreground text-xs">
              {t('phoneNumberIdHint')}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="meta-waba">{t('wabaId')}</Label>
            <Input
              id="meta-waba"
              value={wabaId}
              onChange={(e) => setWabaId(e.target.value)}
              placeholder="102290129340398"
            />
            <p className="text-muted-foreground text-xs">{t('wabaIdHint')}</p>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="meta-token">{t('accessToken')}</Label>
          <div className="flex gap-2">
            <Input
              id="meta-token"
              type={showToken ? 'text' : 'password'}
              value={accessToken}
              onChange={(e) => {
                setAccessToken(e.target.value);
                setTokenEdited(true);
              }}
              placeholder="EAAG…"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => setShowToken((v) => !v)}
              aria-label={showToken ? t('hideToken') : t('showToken')}
            >
              {showToken ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            {t('accessTokenHint')}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="meta-app-secret">{t('appSecret')}</Label>
            <Input
              id="meta-app-secret"
              type="password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder={state?.connected ? MASKED : ''}
            />
            <p className="text-muted-foreground text-xs">
              {t('appSecretHint')}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="meta-verify-token">{t('verifyToken')}</Label>
            <Input
              id="meta-verify-token"
              value={verifyToken}
              onChange={(e) => setVerifyToken(e.target.value)}
              placeholder={state?.connected ? MASKED : ''}
            />
            <p className="text-muted-foreground text-xs">
              {t('verifyTokenHint')}
            </p>
          </div>
        </div>

        {/* Meta's webhook is configured by hand in the App dashboard,
            so the URL to paste there is surfaced here. */}
        <div className="space-y-2">
          <Label>{t('webhookUrl')}</Label>
          <div className="flex gap-2">
            <Input readOnly value={webhookUrl} className="font-mono text-xs" />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={copyWebhook}
              aria-label={t('copyWebhook')}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">{t('webhookHint')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
          {state?.connected && (
            <Button
              variant="link"
              size="sm"
              className="h-auto px-0"
              onClick={openNumbersAccess}
            >
              {t('removeInNumbers')}
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          )}
          <a
            href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
          >
            {t('setupGuide')}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
