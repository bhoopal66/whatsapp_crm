'use client';

// ============================================================
// The Whapi half of Settings → WhatsApp, for an account that may hold
// several Whapi numbers (migration 060).
//
// Picks which number the connection panel shows — `?channel=<id>`
// (what Settings → Numbers & access links to), else the default, else
// the oldest — and offers a switcher when there is more than one. The
// panel itself is remounted per number (`key`) so it never has to
// reset its own form state.
// ============================================================

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, Users } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { channelDisplayName } from '@/lib/whatsapp/channel-management';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { WhatsAppConfig } from './whatsapp-config';

interface WhapiNumber {
  id: string;
  label: string | null;
  waba_id: string | null;
  phone_number_id: string;
  is_primary: boolean;
}

export function WhapiNumberPanels() {
  const t = useTranslations('Settings.whatsapp');
  const searchParams = useSearchParams();
  const { accountId } = useAuth();
  const [numbers, setNumbers] = useState<WhapiNumber[] | null>(null);
  // Bumped after a save, so a first connect shows the switcher and the
  // Add / Names & access buttons without a page reload.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      const { data } = await createClient()
        .from('whatsapp_config')
        .select('id, label, waba_id, phone_number_id, is_primary')
        .eq('account_id', accountId)
        .eq('provider', 'whapi')
        .order('created_at', { ascending: true });
      if (!cancelled) setNumbers((data ?? []) as WhapiNumber[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, version]);

  if (numbers === null) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  const requested = searchParams.get('channel');
  const selected =
    numbers.find((n) => n.id === requested) ??
    numbers.find((n) => n.is_primary) ??
    numbers[0] ??
    null;

  const select = (id: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('channel', id);
    // History API, not the router — see settings/page.tsx.
    window.history.replaceState(null, '', `/settings?${params.toString()}`);
  };

  /**
   * Hand off to Settings → Numbers & access, which owns adding numbers,
   * their names, the default, and who works each one. This panel only
   * owns a number's connection (token, webhook, media) — keeping each
   * job on one screen is what stops the two from drifting apart.
   */
  const openNumbers = (add: boolean) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', 'numbers');
    params.delete('channel');
    if (add) params.set('add', '1');
    window.history.replaceState(null, '', `/settings?${params.toString()}`);
  };

  // Nothing connected yet: the panel below IS the first-connect form,
  // with the setup instructions beside it. No switcher to show.
  const picker = selected ? (
    <div className="flex flex-wrap items-center gap-2">
      {numbers.length > 1 && (
        <Select value={selected.id} onValueChange={(v) => v && select(v)}>
          <SelectTrigger
            className="border-border bg-muted text-foreground w-56"
            aria-label={t('numberPicker')}
          >
            <SelectValue>{channelDisplayName(selected)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {numbers.map((n) => (
              <SelectItem key={n.id} value={n.id}>
                {channelDisplayName(n)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button variant="outline" size="sm" onClick={() => openNumbers(false)}>
        <Users className="size-4" />
        {t('manageNumbers')}
      </Button>
      <Button variant="outline" size="sm" onClick={() => openNumbers(true)}>
        <Plus className="size-4" />
        {t('addNumber')}
      </Button>
    </div>
  ) : undefined;

  return (
    <WhatsAppConfig
      key={selected?.id ?? 'none'}
      configId={selected?.id ?? null}
      picker={picker}
      onSaved={() => setVersion((v) => v + 1)}
    />
  );
}
