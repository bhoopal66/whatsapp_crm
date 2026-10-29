'use client';

import { useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import { chunkIds } from '@/lib/contacts/chat-tag-column';
import type { LeadScoreConversation } from '@/lib/pipelines/lead-score';

/**
 * The conversation figures the board's lead scores read
 * (docs/jev-insights.md, "Lead score"), per contact: one batched
 * `.in('contact_id', …)` read per 200 contacts, never one per deal.
 * Conversation RLS decides which chats come back; a deal whose chat the
 * viewer cannot read is scored on stage alone.
 */

export const DEAL_SIGNAL_SELECT =
  'contact_id, insight_lead_temp, insight_urgency, insight_upset, last_message_at, unread_count';

type SignalRow = LeadScoreConversation & { contact_id: string };

/** The narrow client surface the loader uses (tests pass a fake). */
export interface SignalClient {
  from(table: 'conversations'): {
    select(columns: typeof DEAL_SIGNAL_SELECT): {
      in(
        column: 'contact_id',
        values: string[]
      ): PromiseLike<{ data: unknown[] | null; error: unknown }>;
    };
  };
}

export async function loadDealSignals(
  client: SignalClient,
  contactIds: readonly string[]
): Promise<Map<string, LeadScoreConversation>> {
  const ids = [...new Set(contactIds)];
  const byContact = new Map<string, LeadScoreConversation>();
  const pages = await Promise.all(
    chunkIds(ids).map((chunk) =>
      client
        .from('conversations')
        .select(DEAL_SIGNAL_SELECT)
        .in('contact_id', chunk)
    )
  );
  for (const { data, error } of pages) {
    if (error) {
      console.error('[pipelines] lead score signals failed', error);
      continue;
    }
    for (const row of (data ?? []) as SignalRow[]) {
      // One conversation per contact; should a second exist, the most
      // recently active one speaks for the contact.
      const prev = byContact.get(row.contact_id);
      if (!prev || (row.last_message_at ?? '') > (prev.last_message_at ?? '')) {
        byContact.set(row.contact_id, {
          insight_lead_temp: row.insight_lead_temp,
          insight_urgency: row.insight_urgency,
          insight_upset: row.insight_upset,
          last_message_at: row.last_message_at,
          unread_count: row.unread_count,
        });
      }
    }
  }
  return byContact;
}

export interface DealSignals {
  byContact: Map<string, LeadScoreConversation>;
  /** When they were read (epoch ms): the scores' "now". */
  at: number;
}

/** The board's signals, or null while off or loading. */
export function useDealSignals(
  contactIds: readonly string[],
  enabled: boolean
): DealSignals | null {
  const [state, setState] = useState<{
    key: string;
    value: DealSignals;
  } | null>(null);
  const ids = [...new Set(contactIds)].sort();
  // '' (off) is distinct from '-' (on, no contacts: nothing to read).
  const key = enabled ? `-${ids.join(',')}` : '';

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const wanted = key.slice(1) ? key.slice(1).split(',') : [];
    loadDealSignals(createClient() as unknown as SignalClient, wanted).then(
      (byContact) => {
        if (!cancelled) setState({ key, value: { byContact, at: Date.now() } });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [key]);

  return key && state && state.key === key ? state.value : null;
}
