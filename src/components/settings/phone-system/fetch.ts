import type { Tone } from '@/lib/pbx/admin-ui';

export type PbxResult<T> =
  { ok: true; data: T } | { ok: false; status: number; error: string | null };

/** JSON in and out of the /api/pbx routes; never throws. */
export async function pbxFetch<T>(
  url: string,
  init?: { method: string; body?: unknown }
): Promise<PbxResult<T>> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      method: init?.method ?? 'GET',
      headers:
        init?.body === undefined
          ? undefined
          : { 'Content-Type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const json = await res.json().catch(() => null);
    if (res.ok) return { ok: true, data: json as T };
    const error = (json as { error?: unknown } | null)?.error;
    return {
      ok: false,
      status: res.status,
      error: typeof error === 'string' ? error : null,
    };
  } catch {
    return { ok: false, status: 0, error: null };
  }
}

/** The dot colour for a tone. */
export const DOT: Record<Tone, string> = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  grey: 'bg-zinc-400',
  brown: 'bg-orange-800 [[data-mode=dark]_&]:bg-orange-400',
  muted: 'border border-muted-foreground/60 bg-transparent',
};
