import type { SupabaseClient } from '@supabase/supabase-js';

import { startCatchUp } from '@/lib/realtime/catch-up';

const DEBOUNCE_MS = 600;

/**
 * Calls `onChange` (debounced) on any change `key` names (`table:filter`
 * parts joined by `|`), and once more after each gap realtime cannot
 * replay (`startCatchUp`), unless `catchUp` is off. `onChange` resolves
 * to false when its read failed: a catch-up is then tried again. Returns
 * the stop function.
 */
export function startTableSignal(
  sb: Pick<SupabaseClient, 'channel' | 'removeChannel'>,
  key: string,
  onChange: () => unknown,
  catchUp: boolean
): () => void {
  const live = catchUp
    ? startCatchUp(async () => {
        if ((await onChange()) === false) throw new Error('read failed');
      })
    : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void onChange(), DEBOUNCE_MS);
  };
  let ch = sb.channel(`signal:${Math.random().toString(36).slice(2, 10)}`);
  for (const part of key.split('|')) {
    const at = part.indexOf(':');
    ch = ch.on(
      'postgres_changes' as never,
      {
        event: '*',
        schema: 'public',
        table: part.slice(0, at),
        filter: part.slice(at + 1),
      },
      fire
    );
  }
  const sub = ch.subscribe((status) => live?.onStatus(status));
  return () => {
    live?.stop();
    clearTimeout(timer);
    void sb.removeChannel(sub);
  };
}
