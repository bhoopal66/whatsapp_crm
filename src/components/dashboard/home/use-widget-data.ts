'use client';

import { useCallback, useEffect, useEffectEvent, useState } from 'react';

/** One home widget's load, as its panel renders it. */
export interface WidgetData<T> {
  /** The latest successful load; kept while a refresh is in flight. */
  data: T | null;
  /** The current request has not answered yet. */
  loading: boolean;
  /** The current request failed; `data` may still hold an older load. */
  error: boolean;
  /** Ask again, e.g. from the panel's Retry. */
  reload: () => void;
  /** Patch the loaded data in place, e.g. a task ticked off. */
  update: (fn: (data: T) => T) => void;
}

interface Settled<T> {
  key: string;
  data: T | null;
  error: boolean;
}

/**
 * Load a widget's data, and load it again whenever `key` changes: the
 * page's refresh counter plus whatever the loader depends on. A null key
 * means "not yet" (the user or role is still loading) and reads as
 * loading. A refresh keeps the previous data on screen until the new
 * answer lands, so a periodic refresh never flashes skeletons; a failed
 * refresh keeps it too, flagged as `error`.
 */
export function useWidgetData<T>(
  key: string | null,
  load: () => Promise<T>
): WidgetData<T> {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const run = useEffectEvent(load);
  const requestKey = key === null ? null : `${key}#${attempt}`;

  useEffect(() => {
    if (requestKey === null) return;
    let cancelled = false;
    run().then(
      (data) => {
        if (!cancelled) setSettled({ key: requestKey, data, error: false });
      },
      (err: unknown) => {
        console.error('[dashboard] widget load failed:', err);
        if (!cancelled) {
          setSettled((prev) => ({
            key: requestKey,
            data: prev?.data ?? null,
            error: true,
          }));
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [requestKey]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const update = useCallback((fn: (data: T) => T) => {
    setSettled((prev) =>
      prev && prev.data !== null ? { ...prev, data: fn(prev.data) } : prev
    );
  }, []);

  const current = settled !== null && settled.key === requestKey;
  return {
    data: settled?.data ?? null,
    loading: !current,
    error: current && settled.error,
    reload,
    update,
  };
}
