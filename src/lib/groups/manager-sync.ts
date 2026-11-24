// Managers and their saved numbers move together: `manager-numbers.ts`
// decides, this does the WhatsApp calls, for the managers PUT and for the
// managers chosen in the create wizard (whose later PUT sees no change).

import type { SupabaseClient } from '@supabase/supabase-js';

import { addParticipants, removeParticipants } from '@/lib/whatsapp/groups';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';

import { addBudget } from './add-budget';
import {
  planManagerNumbers,
  type ManagerNumbersReport,
  type NumberBlock,
} from './manager-numbers';
import { resyncGroup } from './resync';
import { channelForGroup, GroupHttpError } from './server';
import type { WhatsappGroupRow } from './types';

const identityDigits = (i: { jid: string; waId: string | null }) =>
  (i.waId ?? i.jid.split('@')[0] ?? '').replace(/\D/g, '');

/**
 * Bring the WhatsApp group in line with a manager change. Never throws:
 * the manager rows are already written, so every failure is reported.
 */
export async function syncManagerNumbers(
  admin: SupabaseClient,
  group: WhatsappGroupRow,
  added: string[],
  removed: string[],
  deadline: number,
  callerId: string
): Promise<ManagerNumbersReport> {
  const report: ManagerNumbersReport = { added: [], removed: [], failed: [] };
  const people = [...added, ...removed];
  if (people.length === 0) return report;
  try {
    const names = new Map<string, string>();
    const { data: rows } = await admin
      .from('profiles')
      .select('user_id, full_name')
      .eq('account_id', group.account_id)
      .in('user_id', people);
    for (const p of (rows ?? []) as {
      user_id: string;
      full_name: string | null;
    }[]) {
      if (p.full_name) names.set(p.user_id, p.full_name);
    }
    const phones = new Map<string, string | null>();
    const leaving = new Set(removed);
    for (const userId of people) {
      const { data, error } = await admin.rpc(
        leaving.has(userId) ? 'staff_removal_phone' : 'staff_saved_phone',
        { p_account: group.account_id, p_user: userId }
      );
      if (error) {
        console.error('[groups] saved number lookup failed', error);
        report.failed.push({
          name: names.get(userId) ?? '',
          reason: 'unavailable',
        });
        continue;
      }
      const phone = typeof data === 'string' && data ? data : null;
      phones.set(userId, phone);
      if (!phone && leaving.has(userId)) {
        report.failed.push({
          name: names.get(userId) ?? '',
          reason: 'no_saved_number',
        });
      }
    }
    const lookedUp = (ids: string[]) => ids.filter((u) => phones.has(u));
    const block: NumberBlock | null =
      group.channel_id === null
        ? 'number_removed'
        : group.our_role === 'left'
          ? 'left'
          : group.our_role !== 'admin'
            ? 'not_group_admin'
            : null;
    const { data: parts, error: partsError } = await admin
      .from('whatsapp_group_participants')
      .select('wa_id')
      .eq('account_id', group.account_id)
      .eq('group_id', group.id);
    if (partsError) throw partsError;
    const participants = ((parts ?? []) as { wa_id: string }[]).map(
      (p) => p.wa_id
    );
    const draft = {
      added: lookedUp(added),
      removed: lookedUp(removed),
      phones,
      names,
      participants,
      block,
    };
    // The channel is loaded only when there is something to do on it.
    const first = planManagerNumbers({ ...draft, ourNumber: null });
    for (const s of first.skipped) report.failed.push(s);
    if (first.add.length === 0 && first.remove.length === 0) return report;

    let channel;
    try {
      channel = await channelForGroup(group);
    } catch (err) {
      console.error('[groups] manager numbers: channel load failed', err);
      const reason = err instanceof GroupHttpError ? err.code : 'unavailable';
      for (const c of [...first.add, ...first.remove]) {
        report.failed.push({ name: c.name, reason });
      }
      return report;
    }
    const plan = planManagerNumbers({
      ...draft,
      ourNumber: normalizePhone(channel.wabaId ?? '') || null,
    });

    let changed = false;
    const spent = addBudget(callerId, channel.id).spend(plan.add.length);
    for (const c of plan.add.splice(spent)) {
      report.failed.push({ name: c.name, reason: 'too_many_adds' });
    }
    if (plan.add.length > 0) {
      try {
        const outcome = await addParticipants({
          channel,
          groupId: group.wa_group_id,
          participants: plan.add.map((c) => c.waId),
          deadline,
        });
        const ok = new Set(outcome.added.map(identityDigits));
        const refused = new Set(outcome.refused.map(identityDigits));
        for (const c of plan.add) {
          if (ok.has(c.waId)) {
            report.added.push(c.name);
            changed = true;
          } else if (refused.has(c.waId)) {
            report.failed.push({ name: c.name, reason: 'refused' });
          } else {
            report.failed.push({
              name: c.name,
              reason: outcome.error ?? 'unknown',
            });
          }
        }
      } catch (err) {
        console.error('[groups] manager number add failed', err);
        for (const c of plan.add) {
          report.failed.push({ name: c.name, reason: 'unavailable' });
        }
      }
    }
    if (plan.remove.length > 0) {
      try {
        const result = await removeParticipants({
          channel,
          groupId: group.wa_group_id,
          participants: plan.remove.map((c) => c.waId),
        });
        const ok = new Set(result.processed.map(identityDigits));
        for (const c of plan.remove) {
          if (ok.has(c.waId)) {
            report.removed.push(c.name);
            changed = true;
          } else {
            report.failed.push({ name: c.name, reason: 'unknown' });
          }
        }
      } catch (err) {
        console.error('[groups] manager number removal failed', err);
        for (const c of plan.remove) {
          report.failed.push({ name: c.name, reason: 'unavailable' });
        }
      }
    }
    if (changed) await resyncGroup(channel, group.wa_group_id);
    return report;
  } catch (err) {
    console.error('[groups] manager numbers failed', err);
    return {
      ...report,
      failed: [...report.failed, { name: '', reason: 'unavailable' }],
    };
  }
}
