'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Star, Info } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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
  // Pending edits, keyed by surface. Empty until something changes, so
  // a save only sends what the admin actually touched.
  const [pending, setPending] = useState<Record<string, string | null>>({});
  const [pendingPrimary, setPendingPrimary] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/routes');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load routing');
      setChannels(data.channels ?? []);
      setRows(data.routes ?? []);
      setPending({});
      setPendingPrimary(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

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
          ...(pendingPrimary ? { primary_config_id: pendingPrimary } : {}),
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

  const dirty = Object.keys(pending).length > 0 || pendingPrimary !== null;

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
        {/* Connected numbers, and which one is the fallback. */}
        <div className="space-y-2">
          <Label>{t('connectedNumbers')}</Label>
          {channels.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('noChannels')}</p>
          ) : (
            <ul className="space-y-2">
              {channels.map((channel) => (
                <li
                  key={channel.id}
                  className="border-border flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground truncate text-sm font-medium">
                        {channelName(channel)}
                      </span>
                      <Badge variant="secondary">
                        {channel.provider === 'meta'
                          ? t('providerMeta')
                          : t('providerWhapi')}
                      </Badge>
                      {(pendingPrimary
                        ? pendingPrimary === channel.id
                        : channel.is_primary) && (
                        <Badge className="gap-1">
                          <Star className="h-3 w-3" />
                          {t('primary')}
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground truncate text-xs">
                      {channel.waba_id || channel.phone_number_id}
                    </p>
                  </div>
                  {!(pendingPrimary
                    ? pendingPrimary === channel.id
                    : channel.is_primary) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPendingPrimary(channel.id)}
                    >
                      {t('makePrimary')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-muted-foreground text-xs">{t('primaryHint')}</p>
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
                  </p>
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
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>{t('useDefault')}</SelectItem>
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
                setPendingPrimary(null);
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
