// Time-based automations (migration 321): the runner the automations
// cron calls once a minute.
//
// A time-based automation has no customer of its own, so each scheduled
// minute it acts on chats chosen by its trigger: open company chats
// carrying the configured main chat tag (and sub-tag, when set), whose
// contact has not opted out and is not marked do not contact, and, when
// `quiet_days` is set, with no message for that many days. The chat tag
// is required, so a run never reaches every chat. Each chat runs the
// automation's steps through the ordinary engine, so a message step
// still checks consent, only goes out in a sales chat, and is held to
// the number's daily limit by the send path.
//
// At most once per slot: the (automation, minute) row in
// `automation_schedule_runs` is claimed BEFORE anything runs, so a second
// cron pass, process or replica that sees the same slot does nothing. A
// run that stops at the time limit or the chat cap does not come back for
// the rest; the next slot starts over.
//
// Never throws: a failure is logged and the next automation runs.

import type { SupabaseClient } from '@supabase/supabase-js';

import { salesChatOnce } from '@/lib/ai/not-sales-chat';
import type { Automation } from '@/types';

import { supabaseAdmin } from './admin-client';
import { dueSlot, isKnownTimeZone } from './cron';
import {
  parseTimeBasedConfig,
  TIME_BASED_MAX_CHATS,
  type TimeBasedConfig,
} from './time-based-config';
import { runScheduledAutomation } from './engine';

export { parseTimeBasedConfig, TIME_BASED_MAX_CHATS, type TimeBasedConfig };

/** How far back a missed minute is still run (a cron pinged every few minutes). */
export const TIME_BASED_LOOKBACK_MINUTES = 15;
/** A pass stops starting chats after this long (the cron's after() has 60 s). */
export const TIME_BASED_DEADLINE_MS = 40_000;
/** The zone when neither the trigger nor the workspace names one. */
export const TIME_BASED_DEFAULT_TZ = 'Asia/Dubai';
/** Ledger rows kept this long. */
const RUN_RETENTION_DAYS = 30;

export interface TimeBasedSummary {
  automations: number;
  ran: number;
  chats: number;
  skipped: number;
}

export interface TimeBasedDeps {
  db?: SupabaseClient;
  now?: Date;
  /** Epoch ms after which no new chat is started. */
  deadline?: number;
  run?: typeof runScheduledAutomation;
}

interface Candidate {
  conversationId: string;
  contactId: string;
}

/** One cron pass over every active time-based automation. Never throws. */
export async function runTimeBasedAutomations(
  deps: TimeBasedDeps = {}
): Promise<TimeBasedSummary> {
  const summary: TimeBasedSummary = {
    automations: 0,
    ran: 0,
    chats: 0,
    skipped: 0,
  };
  const now = deps.now ?? new Date();
  const deadline = deps.deadline ?? now.getTime() + TIME_BASED_DEADLINE_MS;
  const run = deps.run ?? runScheduledAutomation;
  try {
    const db = deps.db ?? supabaseAdmin();
    const { data: rows, error } = await db
      .from('automations')
      .select('*')
      .eq('trigger_type', 'time_based')
      .eq('is_active', true);
    if (error) {
      console.error(
        '[time-based] automations could not be read:',
        error.message
      );
      return summary;
    }
    const automations = (rows ?? []) as Automation[];
    summary.automations = automations.length;
    if (automations.length === 0) return summary;

    const zones = await workspaceZones(db, [
      ...new Set(automations.map((a) => a.account_id)),
    ]);

    for (const automation of automations) {
      if (Date.now() > deadline) break;
      try {
        const done = await runOne(db, automation, zones, now, deadline, run);
        if (done === null) continue;
        summary.ran += 1;
        summary.chats += done.run;
        summary.skipped += done.skipped;
      } catch (err) {
        console.error(
          '[time-based] automation failed:',
          automation.id,
          err instanceof Error ? err.message : err
        );
      }
    }

    // Trim the ledger; a failure here changes nothing above.
    await db
      .from('automation_schedule_runs')
      .delete()
      .lt(
        'claimed_at',
        new Date(now.getTime() - RUN_RETENTION_DAYS * 86_400_000).toISOString()
      );
  } catch (err) {
    console.error(
      '[time-based] pass failed:',
      err instanceof Error ? err.message : err
    );
  }
  return summary;
}

/** The Response times zone per workspace (237), where one is saved. */
async function workspaceZones(
  db: SupabaseClient,
  accountIds: string[]
): Promise<Map<string, string>> {
  const zones = new Map<string, string>();
  const { data, error } = await db
    .from('response_settings')
    .select('account_id, timezone')
    .in('account_id', accountIds);
  if (error) return zones; // the default zone stands in
  for (const r of (data ?? []) as {
    account_id: string;
    timezone: string | null;
  }[]) {
    if (r.timezone && isKnownTimeZone(r.timezone))
      zones.set(r.account_id, r.timezone);
  }
  return zones;
}

/** Null when nothing was due (or the slot was already claimed). */
async function runOne(
  db: SupabaseClient,
  automation: Automation,
  zones: Map<string, string>,
  now: Date,
  deadline: number,
  run: typeof runScheduledAutomation
): Promise<{ run: number; skipped: number } | null> {
  const parsed = parseTimeBasedConfig(automation.trigger_config);
  if (!parsed.ok) return null;
  const cfg = parsed.config;
  const tz =
    cfg.timezone ?? zones.get(automation.account_id) ?? TIME_BASED_DEFAULT_TZ;
  // A save (or switching it on) after a slot means that slot is not run.
  const savedAt = Date.parse(String(automation.updated_at ?? ''));
  const slot = dueSlot(
    cfg.schedule,
    tz,
    now,
    TIME_BASED_LOOKBACK_MINUTES,
    Number.isNaN(savedAt)
      ? null
      : new Date(Math.floor(savedAt / 60_000) * 60_000)
  );
  if (!slot) return null;

  // Claim the slot before anything runs: at most once.
  const { data: claimed, error: claimErr } = await db
    .from('automation_schedule_runs')
    .upsert(
      {
        automation_id: automation.id,
        account_id: automation.account_id,
        slot: slot.toISOString(),
      },
      { onConflict: 'automation_id,slot', ignoreDuplicates: true }
    )
    .select('automation_id');
  if (claimErr) {
    console.error(
      '[time-based] slot could not be claimed:',
      automation.id,
      claimErr.message
    );
    return null;
  }
  if (!claimed || claimed.length === 0) return null;

  const candidates = await chooseChats(db, automation.account_id, cfg, now);
  let ran = 0;
  let note: string | null = null;
  for (const c of candidates) {
    if (Date.now() > deadline) {
      note = 'stopped at the time limit';
      break;
    }
    await run(automation, {
      accountId: automation.account_id,
      triggerType: 'time_based',
      contactId: c.contactId,
      context: { conversation_id: c.conversationId, vars: {} },
      customerJustWrote: false,
      salesChat: salesChatOnce(supabaseAdmin, {
        conversationId: c.conversationId,
        inboundChannelId: null,
      }),
    });
    ran += 1;
  }
  if (!note && candidates.length >= TIME_BASED_MAX_CHATS) {
    note = `capped at ${TIME_BASED_MAX_CHATS} chats`;
  }
  await db
    .from('automation_schedule_runs')
    .update({
      finished_at: new Date().toISOString(),
      chats_matched: candidates.length,
      chats_run: ran,
      note,
    })
    .eq('automation_id', automation.id)
    .eq('slot', slot.toISOString());
  return { run: ran, skipped: candidates.length - ran };
}

/**
 * The chats a run acts on: open company chats of the workspace with the
 * tag (and sub-tag), oldest activity first, at most TIME_BASED_MAX_CHATS,
 * leaving out contacts who opted out or are marked do not contact. The
 * engine re-checks consent before every message as well.
 */
export async function chooseChats(
  db: SupabaseClient,
  accountId: string,
  cfg: TimeBasedConfig,
  now: Date
): Promise<Candidate[]> {
  let q = db
    .from('conversations')
    .select('id, contact_id')
    .eq('account_id', accountId)
    .is('personal_owner_id', null)
    .neq('status', 'closed')
    .eq('chat_tag_id', cfg.chatTagId);
  if (cfg.chatSubTagId) q = q.eq('chat_sub_tag_id', cfg.chatSubTagId);
  if (cfg.quietDays) {
    q = q.lt(
      'last_message_at',
      new Date(now.getTime() - cfg.quietDays * 86_400_000).toISOString()
    );
  }
  const { data, error } = await q
    .order('last_message_at', { ascending: true, nullsFirst: true })
    .limit(TIME_BASED_MAX_CHATS);
  if (error) throw new Error(`chats could not be read: ${error.message}`);
  const rows = (
    (data ?? []) as { id: string; contact_id: string | null }[]
  ).filter((r): r is { id: string; contact_id: string } => !!r.contact_id);
  if (rows.length === 0) return [];

  const contactIds = [...new Set(rows.map((r) => r.contact_id))];
  const { data: contacts, error: cErr } = await db
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .in('id', contactIds)
    .is('opted_out_at', null)
    .is('do_not_contact_at', null);
  if (cErr) throw new Error(`contacts could not be read: ${cErr.message}`);
  const reachable = new Set((contacts ?? []).map((c: { id: string }) => c.id));

  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const r of rows) {
    if (!reachable.has(r.contact_id) || seen.has(r.contact_id)) continue;
    seen.add(r.contact_id);
    out.push({ conversationId: r.id, contactId: r.contact_id });
  }
  return out;
}
