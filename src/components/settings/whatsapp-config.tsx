'use client';

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  AlertTriangle,
  RefreshCw,
  KeyRound,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { invalidateCached } from '@/lib/client-cache';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';

/**
 * WhatsApp connection settings, backed by Whapi.Cloud.
 *
 * The Meta version of this panel asked for four separate values
 * (phone number id, WABA id, access token, 2FA PIN) and exposed a
 * three-state health model — credentials valid / number registered /
 * app subscribed — because any one of them could be wrong on its own.
 *
 * A Whapi channel collapses all of that into a single token, so the
 * panel now tracks just two independent questions:
 *
 *   1. **Is the channel live?** (`GET /health` → status AUTH)
 *   2. **Are we receiving inbound?** (is our callback registered?)
 *
 * They're shown separately because they fail separately: a channel can
 * be perfectly healthy while the webhook points at a dead tunnel URL,
 * which looks like "everything works except nothing arrives".
 */

const MASKED_TOKEN = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';

interface ChannelInfo {
  channel_id?: string | null;
  phone?: string | null;
  display_name?: string | null;
  status?: string | null;
  version?: string | null;
  uptime?: number | null;
}

/**
 * A webhook registered on the channel. `ours` is false for any other
 * app's, which receives every message on the number just the same.
 */
interface WebhookHook {
  url: string;
  ours: boolean;
}

/** `/api/whatsapp/config`, scoped to one Whapi number when known (migration 060). */
function configUrl(configId: string | null | undefined): string {
  return configId
    ? `/api/whatsapp/config?config_id=${encodeURIComponent(configId)}`
    : '/api/whatsapp/config';
}

/**
 * One Whapi number's connection panel.
 *
 * `configId` picks which number (an account can hold several since
 * migration 060); without it the panel shows the account's first Whapi
 * number, as it did when there could be only one. The parent remounts
 * it (`key`) to switch numbers, so none of the state below has to know
 * how to reset itself. `picker` is the number switcher, rendered in the
 * panel header when there is more than one.
 */
export function WhatsAppConfig({
  configId = null,
  picker,
  onSaved,
}: {
  configId?: string | null;
  picker?: ReactNode;
  /** After a successful save — lets the parent refresh its number list. */
  onSaved?: () => void;
} = {}) {
  const t = useTranslations('Settings.whatsapp');
  const supabase = createClient();

  // whatsapp_config is one row per ACCOUNT, not per user, so every
  // read keys off `accountId` — a teammate who just joined sees the
  // inviter's saved channel without re-entering anything.
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const [config, setConfig] = useState<WhatsAppConfigType | null>(null);
  const [channel, setChannel] = useState<ChannelInfo | null>(null);
  const [webhookHooks, setWebhookHooks] = useState<WebhookHook[]>([]);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('unknown');
  const [needsReset, setNeedsReset] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');

  const [channelToken, setChannelToken] = useState('');
  const [channelId, setChannelId] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);

  // Inbound-media mirror (issue #466). Deliberately NOT part of
  // handleSave: that path insists on a channel token so it can
  // re-verify, which is a silly toll for flipping a boolean. This
  // writes straight to the row instead — RLS (migration 017)
  // restricts whatsapp_config UPDATE to admins, and only admins can
  // open this section (settings-sections.ts), so no role check here.
  const [mirrorMedia, setMirrorMedia] = useState(true);
  const [savingMirror, setSavingMirror] = useState(false);

  // Guards against re-hydrating the form when the load effect re-runs
  // for reasons unrelated to switching accounts — e.g. Supabase's
  // onAuthStateChange fires a token refresh when the tab regains
  // focus. Without this, that churn overwrites unsaved input.
  const loadedAccountIdRef = useRef<string | null>(null);

  const isWebhookRegistered = Boolean(config?.registered_at);
  const lastRegistrationError = config?.last_registration_error ?? null;

  const applyHealthPayload = useCallback(
    (payload: {
      connected?: boolean;
      needs_reset?: boolean;
      message?: string;
      channel?: ChannelInfo;
      webhook?: { urls?: string[]; hooks?: WebhookHook[] };
    }) => {
      setConnectionStatus(payload.connected ? 'connected' : 'disconnected');
      setNeedsReset(Boolean(payload.needs_reset));
      setStatusMessage(payload.message || '');
      setChannel(payload.channel ?? null);
      // `hooks` says which entries are ours. Without it (an older
      // server), flag nothing rather than everything.
      setWebhookHooks(
        payload.webhook?.hooks ??
          (payload.webhook?.urls ?? []).map((url) => ({ url, ours: true }))
      );
    },
    []
  );

  const fetchConfig = useCallback(
    async (acctId: string) => {
      setLoading(true);
      // The health check is a read-only GET that looks the row up
      // itself, so it need not wait for ours: start both at once (one
      // round trip instead of two). Its answer is only applied when a
      // row exists — without one, the panel shows the not-connected
      // state regardless, exactly as before.
      const healthPromise: Promise<Parameters<typeof applyHealthPayload>[0]> =
        fetch(configUrl(configId), { method: 'GET' }).then((res) => res.json());
      // Settled on every path, so an unused rejection is never reported.
      healthPromise.catch(() => {});
      try {
        // This panel owns ONE Whapi number. Since migration 046 an
        // account can also hold a Meta row, and since 060 several
        // Whapi rows, so the lookup is by id when we have one and
        // otherwise the same "first Whapi row" the API falls back to —
        // without either, maybeSingle() matches several rows, errors,
        // and the panel reports "Not connected" for a healthy channel.
        let query = supabase
          .from('whatsapp_config')
          .select('*')
          .eq('account_id', acctId)
          .eq('provider', 'whapi');
        query = configId
          ? query.eq('id', configId)
          : query
              .order('is_primary', { ascending: false })
              .order('created_at', { ascending: true });
        const { data, error } = await query.limit(1).maybeSingle();

        if (error) console.error('Failed to load config row:', error);

        if (data) {
          setConfig(data);
          setChannelId(data.phone_number_id || '');
          setChannelToken(MASKED_TOKEN);
          setTokenEdited(false);
          // Undefined on a row written before migration 039 — treat
          // that as on, matching the webhook's own default.
          setMirrorMedia(data.mirror_inbound_media !== false);
        } else {
          setConfig(null);
          setChannelId('');
          setChannelToken('');
          setTokenEdited(false);
          setMirrorMedia(true);
        }

        if (data) {
          try {
            applyHealthPayload(await healthPromise);
          } catch (err) {
            console.error('Health check failed:', err);
            setConnectionStatus('disconnected');
          }
        } else {
          setConnectionStatus('disconnected');
          setNeedsReset(false);
          setStatusMessage('');
          setChannel(null);
          setWebhookHooks([]);
        }
      } catch (err) {
        console.error('fetchConfig error:', err);
        toast.error(t('loadFailed'));
      } finally {
        setLoading(false);
      }
    },
    [supabase, applyHealthPayload, t, configId]
  );

  useEffect(() => {
    // Need both the auth session (`!authLoading`) AND the profile
    // (`!profileLoading`, which carries `accountId`). Without the
    // second guard the effect fires with `accountId === null` on the
    // first render window and bails without ever retrying.
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      loadedAccountIdRef.current = null;
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchConfig(accountId);
  }, [authLoading, profileLoading, user?.id, accountId, fetchConfig]);

  async function handleToggleMirrorMedia(next: boolean) {
    if (!config || !accountId || savingMirror) return;
    // Optimistic — the switch should feel instant; a failure rolls it
    // back rather than leaving the UI ahead of the row.
    const previous = mirrorMedia;
    setMirrorMedia(next);
    setSavingMirror(true);
    try {
      const { error } = await supabase
        .from('whatsapp_config')
        .update({ mirror_inbound_media: next })
        .eq('account_id', accountId)
        // This number only — the toggle belongs to this panel. Keyed
        // on anything wider it also flips the Meta channel's setting
        // and every other Whapi number's.
        .eq('id', config.id);
      if (error) throw new Error(error.message);
      setConfig({ ...config, mirror_inbound_media: next });
    } catch (error) {
      console.error('Failed to update media retention setting:', error);
      setMirrorMedia(previous);
      toast.error(t('mirrorInboundSaveFailed'));
    } finally {
      setSavingMirror(false);
    }
  }

  /**
   * Save the channel token and register the webhook.
   *
   * `rotateSecret` re-mints the callback secret; the server otherwise
   * reuses the existing one so a re-save doesn't break a callback URL
   * that is already working.
   */
  async function submitConfig(opts: { rotateSecret?: boolean } = {}) {
    // Unlike the Meta version, a re-save doesn't force the operator to
    // re-type the token — but the server does need one to verify with,
    // so an unedited field means we have nothing new to send.
    if (!tokenEdited || !channelToken.trim() || channelToken === MASKED_TOKEN) {
      toast.error(t('tokenRequired'));
      return false;
    }

    const res = await fetch('/api/whatsapp/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: channelToken.trim(),
        channel_id: channelId.trim() || null,
        rotate_secret: opts.rotateSecret === true,
        // Re-save THIS number; without an id the server would pick the
        // account's first Whapi row.
        config_id: config?.id ?? configId ?? undefined,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      toast.error(data.error || t('saveFailed'));
      return false;
    }

    if (data.registration_error) {
      // Token is good but inbound isn't wired. Long duration: this is
      // the message the operator has to act on.
      toast.error(t('savedNoWebhook', { error: data.registration_error }), {
        duration: 12000,
      });
    } else {
      toast.success(t('saved'));
    }

    // Screens elsewhere cache "is WhatsApp connected" and the number
    // list (inbox banner, contact screen, thread picker); a first
    // connect must not read as "not connected" there for a minute.
    invalidateCached('whatsapp-channels:');
    invalidateCached('whatsapp-status:');
    if (accountId) await fetchConfig(accountId);
    onSaved?.();
    return true;
  }

  async function handleSave() {
    try {
      setSaving(true);
      await submitConfig();
    } catch (err) {
      console.error('Save error:', err);
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleRotateSecret() {
    if (!confirm(t('rotateSecretHint'))) return;
    try {
      setRotating(true);
      await submitConfig({ rotateSecret: true });
    } catch (err) {
      console.error('Rotate error:', err);
      toast.error(t('saveFailed'));
    } finally {
      setRotating(false);
    }
  }

  async function handleTestConnection() {
    try {
      setTesting(true);
      const res = await fetch(configUrl(config?.id ?? configId), {
        method: 'GET',
      });
      const payload = await res.json();
      applyHealthPayload(payload);

      if (payload.connected) {
        toast.success(
          payload.channel?.display_name
            ? `${t('connected')} — ${payload.channel.display_name}`
            : t('connected')
        );
      } else {
        toast.error(payload.message || t('testFailed'));
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setConnectionStatus('disconnected');
      toast.error(t('testFailed'));
    } finally {
      setTesting(false);
    }
  }

  /**
   * Recovery for a token saved under a rotated ENCRYPTION_KEY: put the
   * operator in the token field. Re-saving overwrites the unreadable
   * ciphertext in place (the server mints a fresh callback secret when
   * the old one will not decrypt either), which keeps the number's row —
   * its name, its people, its routes, and the chat history tagged with
   * it (migration 060). Deleting the row, which is what this used to do,
   * would throw all of that away. Disconnecting a number is a separate,
   * deliberate act in Settings → Numbers & access.
   */
  function handleReenterToken() {
    const field = document.getElementById(
      'whapi-token'
    ) as HTMLInputElement | null;
    field?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    field?.focus();
  }

  function copy(value: string) {
    navigator.clipboard.writeText(value);
    toast.success(t('copied'));
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title={t('title')}
          description={t('description')}
          action={picker}
        />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-primary size-6 animate-spin" />
        </div>
      </section>
    );
  }

  const isConnected = connectionStatus === 'connected';

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={picker}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          {/* Corrupted-token recovery. Distinct from a plain
              connection failure: no amount of retrying fixes it, the
              token has to be entered again. */}
          {needsReset && (
            <Alert className="border-warning/30 bg-warning-soft">
              <div className="flex items-start gap-3">
                <AlertTriangle className="text-warning mt-0.5 size-5 shrink-0" />
                <div className="flex-1">
                  <AlertTitle className="text-foreground mb-1">
                    {t('tokenCorrupted')}
                  </AlertTitle>
                  <AlertDescription className="text-muted-foreground text-sm">
                    {statusMessage}
                  </AlertDescription>
                  <Button
                    onClick={handleReenterToken}
                    size="sm"
                    className="mt-3 bg-amber-700 text-white hover:bg-amber-800"
                  >
                    <KeyRound className="size-4" />
                    {t('reenterToken')}
                  </Button>
                </div>
              </div>
            </Alert>
          )}

          {/* Dimension 1 — is the channel live? */}
          <Alert className="bg-card border-border">
            <div className="flex items-center gap-2">
              {isConnected ? (
                <CheckCircle2 className="text-success size-4" />
              ) : (
                <XCircle className="text-destructive size-4" />
              )}
              <AlertTitle className="text-foreground mb-0">
                {isConnected ? t('connected') : t('notConnected')}
              </AlertTitle>
            </div>
            <AlertDescription className="text-muted-foreground">
              {isConnected
                ? t('connectedDesc')
                : statusMessage || t('notConnectedDesc')}
            </AlertDescription>

            {channel && (
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                {channel.phone && (
                  <>
                    <dt className="text-muted-foreground">
                      {t('channelPhone')}
                    </dt>
                    <dd className="text-foreground font-mono">
                      +{channel.phone}
                    </dd>
                  </>
                )}
                {channel.display_name && (
                  <>
                    <dt className="text-muted-foreground">
                      {t('channelName')}
                    </dt>
                    <dd className="text-foreground">{channel.display_name}</dd>
                  </>
                )}
                {channel.channel_id && (
                  <>
                    <dt className="text-muted-foreground">{t('channelId')}</dt>
                    <dd className="text-foreground font-mono">
                      {channel.channel_id}
                    </dd>
                  </>
                )}
                {channel.status && (
                  <>
                    <dt className="text-muted-foreground">
                      {t('channelStatus')}
                    </dt>
                    <dd className="text-foreground font-mono">
                      {channel.status}
                    </dd>
                  </>
                )}
              </dl>
            )}
          </Alert>

          {/* Dimension 2 — are we actually receiving anything?
              Separate from the banner above because these fail
              independently: a healthy channel whose callback points at
              a dead tunnel sends fine and receives nothing. */}
          {config && (
            <Alert
              className={
                isWebhookRegistered
                  ? 'border-success/30 bg-success-soft'
                  : 'border-warning/30 bg-warning-soft'
              }
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {isWebhookRegistered ? (
                    <CheckCircle2 className="text-success size-4" />
                  ) : (
                    <AlertTriangle className="text-warning size-4" />
                  )}
                  <AlertTitle
                    className={
                      'mb-0 ' +
                      (isWebhookRegistered ? 'text-success' : 'text-warning')
                    }
                  >
                    {isWebhookRegistered
                      ? t('webhookRegistered')
                      : t('webhookNotRegistered')}
                  </AlertTitle>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSave}
                    disabled={saving || rotating}
                    className="border-border text-foreground hover:bg-muted h-7 bg-transparent"
                  >
                    {saving ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                    {t('reRegister')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRotateSecret}
                    disabled={saving || rotating}
                    className="border-border text-foreground hover:bg-muted h-7 bg-transparent"
                  >
                    {rotating ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <KeyRound className="size-3.5" />
                    )}
                    {t('rotateSecret')}
                  </Button>
                </div>
              </div>

              <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
                {isWebhookRegistered ? (
                  t('webhookRegisteredSince', {
                    date: config.registered_at
                      ? new Date(config.registered_at).toLocaleString()
                      : t('unknownDate'),
                  })
                ) : (
                  <>
                    {lastRegistrationError && (
                      <>
                        {t('lastAttemptFailed')}
                        <span className="text-destructive">
                          &quot;{lastRegistrationError}&quot;
                        </span>{' '}
                      </>
                    )}
                    {t('webhookNotRegisteredHint')} {t('webhookHttpsHint')}
                  </>
                )}
                {webhookHooks.length > 0 && (
                  <ul className="text-foreground/80 mt-2 space-y-1 font-mono text-[11px]">
                    {webhookHooks.map((hook) => (
                      <li key={hook.url} className="break-all">
                        {hook.url}
                        {!hook.ours && (
                          <span className="border-warning/30 bg-warning-soft text-warning ml-2 inline-flex items-center gap-1 rounded border px-1.5 py-px font-sans text-[11px] font-medium">
                            <AlertTriangle className="size-3 shrink-0" />
                            {t('webhookForeign')}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {/* Kept on purpose (registerWebhook never drops another
                    app's hook), so say where it can be removed. A debug
                    bin left from testing received every customer
                    message on the number, and this screen listed it as
                    ours. */}
                {webhookHooks.some((hook) => !hook.ours) && (
                  <p className="text-warning mt-2">{t('webhookForeignHint')}</p>
                )}
              </AlertDescription>
            </Alert>
          )}

          {/* Credentials */}
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-foreground">
                {t('credentialsTitle')}
              </CardTitle>
              <CardDescription>{t('credentialsDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="whapi-token">{t('channelToken')}</Label>
                <div className="flex gap-2">
                  <Input
                    id="whapi-token"
                    type={showToken ? 'text' : 'password'}
                    value={channelToken}
                    onChange={(e) => {
                      setChannelToken(e.target.value);
                      setTokenEdited(true);
                    }}
                    onFocus={() => {
                      // Clear the mask on first focus so the operator
                      // types into an empty field instead of appending
                      // to a row of bullets.
                      if (!tokenEdited && channelToken === MASKED_TOKEN) {
                        setChannelToken('');
                        setTokenEdited(true);
                      }
                    }}
                    placeholder={t('channelTokenPlaceholder')}
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setShowToken((v) => !v)}
                    className="border-border shrink-0 bg-transparent"
                  >
                    {showToken ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </Button>
                </div>
                {config && !tokenEdited && (
                  <p className="text-muted-foreground text-xs">
                    {t('tokenHidden')}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="whapi-channel-id">{t('channelIdLabel')}</Label>
                <Input
                  id="whapi-channel-id"
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                  placeholder={t('channelIdPlaceholder')}
                  className="font-mono"
                />
                <p className="text-muted-foreground text-xs">
                  {t('channelIdHint')}
                </p>
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                <Button onClick={handleSave} disabled={saving}>
                  {saving ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('saving')}
                    </>
                  ) : (
                    t('saveConfig')
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleTestConnection}
                  disabled={testing || !config}
                  className="border-border bg-transparent"
                >
                  {testing ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('testing')}
                    </>
                  ) : (
                    t('testConnection')
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Media retention */}
          {config && (
            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle className="text-foreground">
                  {t('mediaTitle')}
                </CardTitle>
                <CardDescription>{t('mediaDesc')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="mirror-media">{t('mirrorInbound')}</Label>
                    <p className="text-muted-foreground text-xs">
                      {t('mirrorInboundDesc')}
                    </p>
                  </div>
                  <Switch
                    id="mirror-media"
                    checked={mirrorMedia}
                    disabled={savingMirror}
                    onCheckedChange={handleToggleMirrorMedia}
                  />
                </div>
                {!mirrorMedia && (
                  <p className="text-warning text-xs">
                    {t('mirrorInboundOffWarning')}
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Setup guide */}
        <aside className="space-y-4">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-foreground text-base">
                {t('setupInstructions')}
              </CardTitle>
              <CardDescription>{t('setupInstructionsDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Accordion>
                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                    {t('step1')}
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground space-y-1 text-xs">
                    <p>{t('step1_1')}</p>
                    <p>{t('step1_2')}</p>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                    {t('step2')}
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground space-y-1 text-xs">
                    <p>{t('step2_1')}</p>
                    <p>{t('step2_2')}</p>
                    <p>{t('step2_3')}</p>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                    {t('step3')}
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground space-y-1 text-xs">
                    <p>{t('step3_1')}</p>
                    <p>{t('step3_2')}</p>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                    {t('step4')}
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground space-y-1 text-xs">
                    <p>{t('step4_1')}</p>
                    <p>{t('step4_2')}</p>
                    <p>{t('step4_3')}</p>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>

              <a
                href="https://support.whapi.cloud/help-desk/getting-started/getting-started"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary mt-4 inline-flex items-center gap-1.5 text-xs hover:underline"
              >
                {t('whapiDocs')}
                <ExternalLink className="size-3" />
              </a>
            </CardContent>
          </Card>

          {/* The callback URL is shown redacted so an operator can
              sanity-check the host without the secret leaking into a
              screenshot or a support thread. */}
          {webhookHooks.length > 0 && (
            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle className="text-foreground text-base">
                  {t('webhookTitle')}
                </CardTitle>
                <CardDescription>{t('webhookDesc')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <Label className="text-xs">{t('webhookUrl')}</Label>
                {webhookHooks.map((hook) => (
                  <div key={hook.url} className="space-y-1">
                    <p
                      className={
                        'flex items-center gap-1 text-[11px] ' +
                        (hook.ours
                          ? 'text-muted-foreground'
                          : 'text-warning font-medium')
                      }
                    >
                      {!hook.ours && (
                        <AlertTriangle className="size-3 shrink-0" />
                      )}
                      {hook.ours ? t('webhookOurs') : t('webhookForeign')}
                    </p>
                    <div className="flex gap-2">
                      <Input
                        readOnly
                        value={hook.url}
                        className={
                          'font-mono text-xs' +
                          (hook.ours
                            ? ''
                            : ' border-warning/50 bg-warning-soft')
                        }
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => copy(hook.url)}
                        className="border-border shrink-0 bg-transparent"
                      >
                        <Copy className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
                {webhookHooks.some((hook) => !hook.ours) && (
                  <p className="text-warning text-xs">
                    {t('webhookForeignHint')}
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </section>
  );
}
