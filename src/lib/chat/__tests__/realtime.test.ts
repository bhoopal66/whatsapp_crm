import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { subscribeChat } from '../realtime';

interface Binding {
  event: string;
  table: string;
  filter?: string;
  fn: (p: unknown) => void;
}

function subscribed() {
  const bindings: Binding[] = [];
  const ch: Record<string, unknown> = {
    on: (_t: string, f: Omit<Binding, 'fn'>, fn: (p: unknown) => void) => {
      bindings.push({ ...f, fn });
      return ch;
    },
    subscribe: () => ch,
  };
  const sb = {
    channel: () => ch,
    removeChannel: () => {},
  } as unknown as SupabaseClient;
  const seen: { type: string; id: string }[] = [];
  subscribeChat(sb, {
    accountId: 'acc',
    userId: 'u1',
    onChannel: (e) => seen.push({ type: e.type, id: e.channel.id }),
  });
  return { bindings, seen };
}

describe('subscribeChat chat_channels', () => {
  // Default replica identity: a DELETE's old row is the id alone, so the
  // account filter can never match it.
  it('hears a DELETE with an id-only old row on an unfiltered binding', () => {
    const { bindings, seen } = subscribed();
    const del = bindings.find(
      (b) => b.table === 'chat_channels' && b.event === 'DELETE'
    );
    expect(del).toBeDefined();
    expect(del).not.toHaveProperty('filter');
    del!.fn({ eventType: 'DELETE', new: {}, old: { id: 'ch1' } });
    expect(seen).toEqual([{ type: 'delete', id: 'ch1' }]);
  });

  it('keeps inserts and updates on the account filter', () => {
    const { bindings } = subscribed();
    const all = bindings.find(
      (b) => b.table === 'chat_channels' && b.event === '*'
    );
    expect(all?.filter).toBe('account_id=eq.acc');
  });
});
