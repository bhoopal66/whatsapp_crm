'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Star, Info } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * The admin routing selector: which connected number sends what.
 *
 * Only meaningful once BOTH numbers are connected — a Whapi channel for
 * conversations and a Meta Cloud API number for marketing — so the
 * panel explains itself and stays out of the way while only one is.
 *
 * Two of the six surfaces are deliberately advisory, and the UI says so
 * rather than pretending otherwise: replies in the inbox and through
 * the public API follow whichever number the customer last wrote to,
 * and consult their route only for a thread with no inbound history.
 * Answering someone from a number they never contacted is confusing,
 * and on Meta it also falls outside the 24-hour service window.
 */

/** Sentinel for "no explicit route — inherit the primary channel". */
const INHERIT = '__inherit__';

interface RoutingChannel {
  id: string;
  provider: 'whapi' | 'meta';
  label: string | null;
  phone_number_id: string;
  waba_id: string | null;
  is_primary: boolean;
  status: string;
}

interface RoutingRow {
  surface: string;
  description: string;
  config_id: string | null;
  effective_config_id: string | null;
  follows_conversation: boolean;
}

export function WhatsAppRouting() {
  const t = useTranslations('Settings.whatsappRouting');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [channels, setChannels] = useState<RoutingChannel[]>([]);
  const [rows, setRows] = useState<RoutingRow[]>([]);
  // Whether the AI answers on every number (Settings → AI). Any failure
  // to read it just means no hint.
  const [aiOnAllNumbers, setAiOnAllNumbers] = useState(false);
  // Pending edits, keyed by surface. Empty until something changes, so
  // a save only sends what the admin actually touched.
  const [pending, setPending] = useState<Record<string, string | null>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/routes');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load routing');
      setChannels(data.channels ?? []);
      setRows(data.routes ?? []);
      setPending({});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/ai/config');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setAiOnAllNumbers(data?.reply_on_all_numbers === true);
      } catch {
        // No hint.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const channelName = (channel: RoutingChannel) =>
    channel.label ||
    channel.waba_id ||
    channel.phone_number_id ||
    t('unnamedChannel');

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/routes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routes: pending,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('saveFailed'));
      toast.success(t('saved'));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const dirty = Object.keys(pending).length > 0;

  const defaultChannel =
    channels.find((c) => c.is_primary) ?? channels[0] ?? null;

  /** Settings → Numbers & access, via the History API like the rail. */
  const openNumbers = () => {
    const params = new URLSearchParams(window.location.search);
    params.set('tab', 'numbers');
    params.delete('channel');
    window.history.replaceState(null, '', `/settings?${params.toString()}`);
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
        <CardTitle className="text-foreground">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* The fallback number. Chosen in Settings → Numbers & access,
            which owns everything about the numbers themselves (names,
            default, who works each one) — shown here read-only because
            every "Use default" below resolves to it. One place to set
            it means the two screens can never disagree. */}
        <div className="border-border flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2">
          <div className="min-w-0 text-sm">
            <span className="text-muted-foreground">{t('defaultIs')} </span>
            {defaultChannel ? (
              <span className="text-foreground inline-flex items-center gap-1 font-medium">
                <Star className="h-3 w-3" />
                {channelName(defaultChannel)}
              </span>
            ) : (
              <span className="text-muted-foreground">{t('noChannels')}</span>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={openNumbers}>
            {t('manageNumbers')}
          </Button>
        </div>

        {channels.length < 2 && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>{t('needBothHint')}</AlertDescription>
          </Alert>
        )}

        {/* Per-surface selectors. */}
        <div className="space-y-4">
          <Label>{t('perTask')}</Label>
          {rows.map((row) => {
            const value =
              row.surface in pending
                ? (pending[row.surface] ?? INHERIT)
                : (row.config_id ?? INHERIT);

            return (
              <div
                key={row.surface}
                className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_240px] sm:items-center"
              >
                <div className="min-w-0">
                  <p className="text-foreground text-sm font-medium">
                    {t(`surface.${row.surface}`)}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t(`surfaceDesc.${row.surface}`)}
                    {row.follows_conversation
                      ? ` ${t('followsConversation')}`
                      : ''}
                    {row.surface === 'inbox'
                      ? ` ${t('allocatedStartHint')}`
                      : ''}
                  </p>
                  {row.surface === 'ai_reply' && aiOnAllNumbers && (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('aiOnAllNumbersHint')}
                    </p>
                  )}
                </div>
                <Select
                  value={value}
                  onValueChange={(next) =>
                    setPending((prev) => ({
                      ...prev,
                      [row.surface]: next === INHERIT ? null : next,
                    }))
                  }
                  disabled={channels.length === 0}
                >
                  <SelectTrigger aria-label={t(`surface.${row.surface}`)}>
                    {/* Base UI's SelectValue renders the raw value unless
                        given children — which here is the `__inherit__`
                        sentinel or a UUID. Name it instead. */}
                    <SelectValue>
                      {value === INHERIT
                        ? defaultChannel
                          ? t('useDefaultNamed', {
                              name: channelName(defaultChannel),
                            })
                          : t('useDefault')
                        : (() => {
                            const picked = channels.find((c) => c.id === value);
                            return picked
                              ? channelName(picked)
                              : t('unnamedChannel');
                          })()}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>
                      {defaultChannel
                        ? t('useDefaultNamed', {
                            name: channelName(defaultChannel),
                          })
                        : t('useDefault')}
                    </SelectItem>
                    {channels.map((channel) => (
                      <SelectItem key={channel.id} value={channel.id}>
                        {channelName(channel)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={!dirty || saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
          {dirty && (
            <Button
              variant="ghost"
              onClick={() => {
                setPending({});
              }}
              disabled={saving}
            >
              {t('discard')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
