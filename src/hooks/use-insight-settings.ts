'use client';

// ============================================================
// The account's Smart insights settings (migration 147), as every
// screen that adapts to them reads them: the inbox, the composer, the
// chat header, Settings → Smart insights.
//
// Slow-moving reference data, so it goes through `cachedQuery` under a
// key naming the account and the person (`canEdit` depends on the
// role). `reload()` drops the key, reads again and hands the fresh
// answer to EVERY mounted consumer, so a save in Settings is seen by
// the inbox without waiting for the TTL (the useChatTags pattern).
// ============================================================

import { useCallback, useEffect, useState } from 'react';

import {
  REFERENCE_CACHE_TTL_MS,
  cachedQuery,
  invalidateCached,
} from '@/lib/client-cache';
import {
  INSIGHT_SETTINGS_OFF,
  type InsightSettings,
  type InsightSettingsResponse,
} from '@/lib/insights/settings-shape';
import { useAuth } from '@/hooks/use-auth';

export function insightSettingsCacheKey(
  accountId: string,
  userId: string
): string {
  return `insight-settings:${accountId}:${userId}`;
}

interface Loaded {
  key: string;
  value: InsightSettingsResponse;
}

type Listener = (loaded: Loaded) => void;

const listeners = new Set<Listener>();

/** Bumped by a reload; a first load that started earlier is dropped. */
let generation = 0;

/** A failed read throws inside the loader (evicted), then answers null. */
function loadInsightSettings(
  key: string
): Promise<InsightSettingsResponse | null> {
  return cachedQuery(key, REFERENCE_CACHE_TTL_MS, async () => {
    const res = await fetch('/api/insights/settings', { cache: 'no-store' });
    if (!res.ok) throw new Error(`insight settings: HTTP ${res.status}`);
    return (await res.json()) as InsightSettingsResponse;
  }).catch((err: unknown) => {
    console.error('[insights] settings load failed', err);
    return null;
  });
}

/** Everything off until loaded, and when the read fails. */
const FALLBACK: InsightSettingsResponse = {
  settings: INSIGHT_SETTINGS_OFF,
  available: false,
  canEdit: false,
};

export function useInsightSettings(): {
  settings: InsightSettings;
  /** Jev can run for this workspace (server key + allowlist). */
  available: boolean;
  canEdit: boolean;
  loading: boolean;
  reload: () => Promise<void>;
} {
  const { accountId, user } = useAuth();
  const userId = user?.id ?? null;
  const key =
    accountId && userId ? insightSettingsCacheKey(accountId, userId) : null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    listeners.add(setLoaded);
    return () => {
      listeners.delete(setLoaded);
    };
  }, []);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const started = generation;
    loadInsightSettings(key).then((value) => {
      if (!cancelled && started === generation)
        setLoaded({ key, value: value ?? FALLBACK });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const reload = useCallback(async () => {
    if (!key) return;
    setReloading(true);
    try {
      invalidateCached(key);
      const value = await loadInsightSettings(key);
      // A failed read keeps what every screen already shows.
      if (!value) return;
      generation += 1;
      for (const listener of listeners) listener({ key, value });
    } finally {
      setReloading(false);
    }
  }, [key]);

  // Another account's or person's answer is not this one's.
  const current = loaded && loaded.key === key ? loaded.value : null;
  const value = current ?? FALLBACK;
  return {
    settings: value.settings,
    available: value.available,
    canEdit: value.canEdit,
    loading: !!key && (current === null || reloading),
    reload,
  };
}
