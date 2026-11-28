// ============================================================
// The time-based pass of the automations cron.
//
// For each active `time_based` automation that is due (`dueOccurrence`),
// reads the chats at its chat tag, claims (automation, chat, occurrence)
// in `automation_time_runs` (migration 324) and starts the automation
// for each chat it claimed. The claim comes first: a chat whose claim
// another pass already holds is not started again, so an overlapping or
// repeated cron starts each chat at most once per occurrence. A run that
// dies after its claim is not retried (at most once, as a step is).
//
// Runs inside `after()` from `GET /api/automations/cron`, at most once
// a minute per process. Never throws.
// ============================================================

import { salesChatOnce } from '@/lib/ai/not-sales-chat';
import type { Automation } from '@/types';

import { supabaseAdmin } from './admin-client';
import { runAutomationForSubject } from './engine';
import {
  dueOccurrence,
  timeBasedSubjects,
  type TimeBasedCandidate,
  type TimeBasedConfig,
} from './time-based';

/** Chats one automation starts in one pass; the rest go next minute. */
export const TIME_BASED_PER_PASS = 100;
const PAGE = 500;
/** Pages of tagged chats read for one automation in one pass. */
const MAX_PAGES = 20;

export interface TimeBasedPassResult {
  due: number;
  started: number;
}

export async function runTimeBasedAutomations(
  now: Date = new Date()
): Promise<TimeBasedPassResult> {
  const result: TimeBasedPassResult = { due: 0, started: 0 };
  const db = supabaseAdmin();
  const { data: automations, error } = await db
    .from('automations')
    .select('*')
    .eq('trigger_type', 'time_based')
    .eq('is_active', true);
  if (error) {
    console.error('[automations] time-based read failed:', error.message);
    return result;
  }
  for (const automation of (automations ?? []) as Automation[]) {
    try {
      const occurrence = dueOccurrence(
        automation.trigger_config as TimeBasedConfig,
        automation.created_at,
        now
      );
      if (!occurrence) continue;
      result.due += 1;
      result.started += await runOccurrence(automation, occurrence);
    } catch (err) {
      console.error(
        '[automations] time-based pass failed:',
        automation.id,
        err instanceof Error ? err.message : err
      );
    }
  }
  return result;
}

async function runOccurrence(
  automation: Automation,
  occurrence: string
): Promise<number> {
  const db = supabaseAdmin();
  const cfg = automation.trigger_config as TimeBasedConfig;

  const { data: done, error: doneErr } = await db
    .from('automation_time_runs')
    .select('conversation_id')
    .eq('automation_id', automation.id)
    .eq('occurrence_at', occurrence);
  if (doneErr) throw new Error(`claims: ${doneErr.message}`);
  const claimed = new Set(
    ((done ?? []) as { conversation_id: string }[]).map(
      (r) => r.conversation_id
    )
  );

  const subjects = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = db
      .from('conversations')
      .select(
        'id, contact_id, contact:contacts(opted_out_at, do_not_contact_at)'
      )
      .eq('account_id', automation.account_id)
      .eq('chat_tag_id', cfg.chat_tag_id as string)
      .is('personal_owner_id', null);
    if (typeof cfg.chat_sub_tag_id === 'string' && cfg.chat_sub_tag_id) {
      q = q.eq('chat_sub_tag_id', cfg.chat_sub_tag_id);
    }
    const { data, error } = await q
      .order('id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`chats: ${error.message}`);
    const rows = (data ?? []) as TimeBasedCandidate[];
    subjects.push(
      ...timeBasedSubjects(rows, claimed, TIME_BASED_PER_PASS - subjects.length)
    );
    if (subjects.length >= TIME_BASED_PER_PASS || rows.length < PAGE) break;
  }
  if (subjects.length === 0) return 0;

  // Only the rows this insert wrote come back: a chat another pass
  // claimed in the meantime is left to that pass.
  const { data: won, error: claimErr } = await db
    .from('automation_time_runs')
    .upsert(
      subjects.map((s) => ({
        automation_id: automation.id,
        account_id: automation.account_id,
        conversation_id: s.conversationId,
        occurrence_at: occurrence,
      })),
      {
        onConflict: 'automation_id,conversation_id,occurrence_at',
        ignoreDuplicates: true,
      }
    )
    .select('conversation_id');
  if (claimErr) throw new Error(`claim: ${claimErr.message}`);
  const mine = new Set(
    ((won ?? []) as { conversation_id: string }[]).map((r) => r.conversation_id)
  );

  let started = 0;
  for (const s of subjects) {
    if (!mine.has(s.conversationId)) continue;
    await runAutomationForSubject({
      automation,
      contactId: s.contactId,
      conversationId: s.conversationId,
      salesChat: salesChatOnce(supabaseAdmin, {
        conversationId: s.conversationId,
        inboundChannelId: null,
      }),
    });
    started += 1;
  }
  return started;
}
