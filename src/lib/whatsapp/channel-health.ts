// ============================================================
// Channel health monitor — is each linked number still on WhatsApp?
//
// A Whapi channel is a linked device. The phone behind it can drop that
// link (a logout, a reinstall, "log out from all devices") while the
// channel token stays perfectly valid, and from then on every inbound
// message stops arriving and every reply fails. Nothing else notices:
// `whatsapp_config.status` used to be written once, at connect time, and
// the 29 Sep outage ran for hours with the row still saying 'connected'.
//
// So a cron tick (`GET /api/whatsapp/health/cron`, and piggy-backed on
// the automation cron) probes each Whapi number's `/health`, flips
// `status` on a transition, and tells the account's owners and admins —
// in words that name the physical fix and who has to do it, because an
// admin who can *see* "Waiting for QR scan" in Settings still does not
// know the phone's holder has to act.
//
// OpenWA numbers (a self-hosted linked-device gateway) are swept the
// same way, with their own status words.
//
// Meta numbers are not probed: a Cloud API number has no session to
// lose, and its failures (token, window) surface on the send itself.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  loadLinkedChannelsForHealth,
  type WhatsAppChannel,
  type WhatsAppProvider,
} from './channels';
import { sweepAbandonedOpenWASessions } from './openwa-cleanup';
import { disconnectOpenWANumber, phoneAlreadyConnected } from './openwa-number';
import { probeChannel, type ChannelProbe } from './provider';

/** What one probe of a number came back with. */
export type ProbeOutcome =
  | { ok: true; status: string; phone?: string | null }
  /** `httpStatus` null when the failure carried none (a bug, not the gateway). */
  | { ok: false; httpStatus: number | null; message: string };

export type HealthReason =
  | 'paired'
  | 'logged_out'
  | 'error_state'
  | 'token_refused'
  | 'billing'
  | 'inconclusive';

export interface HealthVerdict {
  /** The `whatsapp_config.status` the row should now hold. */
  status: string;
  /** Set only when `status` changed — one alert per transition. */
  notify: 'down' | 'up' | null;
  reason: HealthReason;
  /** Whapi's status word or `HTTP n`, for the log and the alert. */
  detail: string;
}

/**
 * The status a number should hold after a probe. Pure.
 *
 * Only unambiguous answers move it. `AUTH` is up. `QR` (logged out) and
 * `ERROR` are down, and so is a probe the gateway refuses outright —
 * 401/403 (token revoked), 404 (the channel no longer exists) and 402
 * (subscription lapsed). Everything else leaves it as it was: `LAUNCH`
 * and `INIT` are a channel starting or syncing (a re-pair passes through
 * them), `NOT_INIT` is what a missing status text maps to, an unknown
 * word may be a sleeping channel, and a 5xx or timeout is Whapi's blip,
 * not the number's — none of which should page anybody.
 *
 * OpenWA's `disconnected` is down only when `disconnectedConfirmed`: the
 * gateway resets every session to it on each boot and relaunches them one
 * by one, so one look proves nothing (see `confirmDisconnected`).
 */
export function nextHealth(
  prevStatus: string,
  probe: ProbeOutcome,
  provider: WhatsAppProvider = 'whapi',
  disconnectedConfirmed = false
): HealthVerdict {
  let status = prevStatus;
  let reason: HealthReason = 'inconclusive';
  let detail: string;

  if (provider === 'openwa') {
    // OpenWA speaks its own words (ready, qr_ready, …), and a 402 means
    // nothing there: never let one provider's vocabulary reach the
    // other's mapping. created / initializing / authenticating, unknown
    // words and any other failure (5xx, 409, timeouts) change nothing.
    if (probe.ok) {
      detail = probe.status;
      if (probe.status === 'ready') {
        status = 'connected';
        reason = 'paired';
      } else if (
        probe.status === 'qr_ready' ||
        (probe.status === 'disconnected' && disconnectedConfirmed)
      ) {
        status = 'disconnected';
        reason = 'logged_out';
      } else if (
        probe.status === 'failed' ||
        probe.status === 'action_required'
      ) {
        status = 'disconnected';
        reason = 'error_state';
      }
    } else {
      const code = probe.httpStatus;
      detail = code === null ? probe.message : `HTTP ${code}`;
      // 401/403: the API key is refused; 404: the session is gone.
      if (code === 401 || code === 403 || code === 404) {
        status = 'disconnected';
        reason = 'token_refused';
      }
    }
  } else if (probe.ok) {
    detail = probe.status;
    if (probe.status === 'AUTH') {
      status = 'connected';
      reason = 'paired';
    } else if (probe.status === 'QR') {
      status = 'disconnected';
      reason = 'logged_out';
    } else if (probe.status === 'ERROR') {
      status = 'disconnected';
      reason = 'error_state';
    }
  } else {
    const code = probe.httpStatus;
    detail = code === null ? probe.message : `HTTP ${code}`;
    if (code === 401 || code === 403 || code === 404) {
      status = 'disconnected';
      reason = 'token_refused';
    } else if (code === 402) {
      status = 'disconnected';
      reason = 'billing';
    }
  }

  return verdictFor(prevStatus, status, reason, detail);
}

/**
 * How long a number must have stayed on OpenWA's `disconnected` before it
 * is believed: the five minutes between two ticks, less the slack a tick
 * may come early by (see `everyInterval`).
 */
export const OPENWA_DISCONNECTED_CONFIRM_MS = 4.5 * 60_000;

/**
 * Record one probe in `firstSeen` (number id → when the current run of
 * `disconnected` answers began) and say whether the run is long enough to
 * believe. `ready`, or an answer that is down on its own, ends the run. An
 * inconclusive one does not: OpenWA retries a dead session for ever, so it
 * alternates `disconnected` and `initializing`. In this process only: after
 * a restart of the app a run starts again.
 */
export function confirmDisconnected(
  firstSeen: Map<string, number>,
  channel: Pick<WhatsAppChannel, 'id' | 'provider'>,
  probe: ProbeOutcome,
  nowMs: number
): boolean {
  if (channel.provider !== 'openwa') return false;
  if (!probe.ok || probe.status !== 'disconnected') {
    if (nextHealth('', probe, 'openwa').reason !== 'inconclusive') {
      firstSeen.delete(channel.id);
    }
    return false;
  }
  const since = firstSeen.get(channel.id);
  if (since === undefined) {
    firstSeen.set(channel.id, nowMs);
    return false;
  }
  return nowMs - since >= OPENWA_DISCONNECTED_CONFIRM_MS;
}

const disconnectedSince = new Map<string, number>();

function verdictFor(
  prevStatus: string,
  status: string,
  reason: HealthReason,
  detail: string
): HealthVerdict {
  const notify =
    status === prevStatus
      ? null
      : status === 'disconnected'
        ? 'down'
        : status === 'connected'
          ? 'up'
          : null;
  return { status, notify, reason, detail };
}

export type ChannelAlertType = 'channel_disconnected' | 'channel_reconnected';

export interface ChannelAlert {
  type: ChannelAlertType;
  title: string;
  body: string;
}

type AlertChannel = Pick<
  WhatsAppChannel,
  'label' | 'wabaId' | 'phoneNumberId'
> & { provider?: WhatsAppProvider; isPersonal?: boolean };

/** `Support (…2504)`. `waba_id` holds the display number on a Whapi row. */
function shortName(channel: AlertChannel): string {
  const digits = (channel.wabaId ?? '').replace(/\D/g, '');
  const tail = digits ? `…${digits.slice(-4)}` : null;
  // The default label is the number itself ("WhatsApp 9715…"), which
  // would only repeat the tail.
  const label =
    channel.label && channel.label.replace(/\D/g, '') !== digits
      ? channel.label
      : null;
  if (label && tail) return `${label} (${tail})`;
  return label || tail || channel.label || channel.phoneNumberId;
}

function fullNumber(channel: AlertChannel): string {
  const digits = (channel.wabaId ?? '').replace(/\D/g, '');
  return digits ? `+${digits}` : 'this number';
}

/**
 * The notification for a transition, or null when there is none.
 *
 * Each body names the fix and who does it. The logout case matters
 * most: the token is fine, so re-saving it — or removing and re-adding
 * the number, which drops its name, people and history — does nothing.
 * The fix is on the phone.
 */
export function channelHealthAlert(
  channel: AlertChannel,
  verdict: HealthVerdict
): ChannelAlert | null {
  const name = shortName(channel);

  if (channel.provider === 'openwa') {
    return openwaAlert(name, verdict, channel.isPersonal === true);
  }

  if (verdict.notify === 'up') {
    return {
      type: 'channel_reconnected',
      title: `WhatsApp number ${name} is connected again`,
      body:
        'Whapi reports it paired and able to send. Messages customers sent ' +
        'while it was down may be missing from the inbox — check the phone’s ' +
        'WhatsApp for chats since it dropped, and re-send any replies that ' +
        'failed (failed replies were not saved).',
    };
  }
  if (verdict.notify !== 'down') return null;

  const until =
    'Until then no messages arrive from customers and every reply from this ' +
    'number fails.';
  switch (verdict.reason) {
    case 'logged_out':
      return {
        type: 'channel_disconnected',
        title: `WhatsApp number ${name} is logged out`,
        body:
          `The phone with ${fullNumber(channel)} was unlinked from Whapi. ` +
          'Someone with access to panel.whapi.cloud must open this channel’s ' +
          'QR code, and whoever holds that phone scans it from WhatsApp → ' +
          `Linked devices → Link a device. ${until} Do not re-save the token ` +
          'or re-add the number in Settings — that does not fix a logout.',
      };
    case 'error_state':
      return {
        type: 'channel_disconnected',
        title: `WhatsApp number ${name} is disconnected`,
        body:
          'Whapi reports this channel in an error state. Someone with access ' +
          'to panel.whapi.cloud must open the channel there and restart it, ' +
          `or re-pair the phone with ${fullNumber(channel)}. ${until}`,
      };
    case 'billing':
      return {
        type: 'channel_disconnected',
        title: `WhatsApp number ${name} is disconnected`,
        body:
          `Whapi refused this channel (${verdict.detail}): its subscription ` +
          'has lapsed. Whoever pays for Whapi must renew it at ' +
          `panel.whapi.cloud. ${until}`,
      };
    default:
      return {
        type: 'channel_disconnected',
        title: `WhatsApp number ${name} is disconnected`,
        body:
          `Whapi no longer accepts the saved token (${verdict.detail}): the ` +
          'channel was deleted or its token changed. An admin must copy the ' +
          'channel’s current token from panel.whapi.cloud into Settings → ' +
          `WhatsApp. ${until}`,
      };
  }
}

/**
 * OpenWA's wording: no panel.whapi.cloud, the fix is the QR in Settings.
 * A personal number (190) is its holder's to re-link, and the alert goes
 * to them, so it names their own screen and phone.
 */
function openwaAlert(
  name: string,
  verdict: HealthVerdict,
  personal: boolean
): ChannelAlert | null {
  const relink = personal
    ? 'Re-link it in Settings → Profile → My WhatsApp by scanning the QR'
    : 'An admin must re-link it in Settings → WhatsApp by scanning the QR';
  const scan = personal
    ? 'with your phone, from WhatsApp → Linked devices'
    : 'and whoever holds the phone scans it from WhatsApp → Linked devices';
  if (verdict.notify === 'up') {
    return {
      type: 'channel_reconnected',
      title: `WhatsApp number ${name} is connected again`,
      body:
        'The OpenWA gateway reports it linked and able to send. Messages ' +
        'customers sent while it was down may be missing from the inbox — ' +
        'check the phone’s WhatsApp for chats since it dropped, and re-send ' +
        'any replies that failed (failed replies were not saved).',
    };
  }
  if (verdict.notify !== 'down') return null;
  const until =
    'Until then no messages arrive from customers and every reply from this ' +
    'number fails.';
  if (verdict.reason === 'token_refused') {
    return {
      type: 'channel_disconnected',
      title: `WhatsApp number ${name} is disconnected`,
      body:
        `The OpenWA gateway no longer accepts this number (${verdict.detail}): ` +
        `its session was deleted or the API key changed. ${relink}. ${until}`,
    };
  }
  return {
    type: 'channel_disconnected',
    title: `WhatsApp number ${name} is ${
      verdict.reason === 'logged_out' ? 'logged out' : 'disconnected'
    }`,
    body:
      `The OpenWA gateway reports this number as ${verdict.detail}. ` +
      `${relink}, ${scan}. ${until}`,
  };
}

/**
 * Run a probe and fold both outcomes into one shape. The error's HTTP
 * status is read structurally: this module stays provider-blind.
 */
async function probeOutcome(
  probe: (channel: WhatsAppChannel) => Promise<ChannelProbe | null>,
  channel: WhatsAppChannel
): Promise<ProbeOutcome | null> {
  try {
    const result = await probe(channel);
    return result
      ? { ok: true, status: result.status, phone: result.phone }
      : null;
  } catch (err) {
    const status = (err as { status?: unknown } | null)?.status;
    return {
      ok: false,
      httpStatus: typeof status === 'number' ? status : null,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

type PairedRow = Pick<WhatsAppChannel, 'id' | 'accountId' | 'wabaId' | 'label'>;

/**
 * The write that brings a Whapi row's stored number up to the phone
 * Whapi reports paired, or null when there is nothing to change. Pure.
 *
 * `waba_id` holds the display number on a Whapi row, and it used to be
 * written only when the token was saved. A channel re-paired to another
 * phone (panel.whapi.cloud → QR → a different handset) kept showing the
 * old number everywhere it is read — the inbox's number picker, the
 * conversation list, alerts — while Settings, which asks Whapi live,
 * showed the new one. A label that is still the save path's default
 * (`WhatsApp <number>`) follows the number; a name someone typed stays.
 */
export function pairedNumberPatch(
  row: Pick<PairedRow, 'wabaId' | 'label'>,
  livePhone: string | null | undefined
): { waba_id: string; label?: string } | null {
  const live = livePhone?.trim() ?? '';
  const liveDigits = live.replace(/\D/g, '');
  if (!liveDigits) return null;
  if (liveDigits === (row.wabaId ?? '').replace(/\D/g, '')) return null;
  const patch: { waba_id: string; label?: string } = { waba_id: live };
  if (row.wabaId && row.label === `WhatsApp ${row.wabaId}`) {
    patch.label = `WhatsApp ${live}`;
  }
  return patch;
}

/**
 * Store the paired number when it changed (see `pairedNumberPatch`).
 * Returns the row as it now reads. Best-effort: it never throws, and the
 * write is conditional on the number it replaces, so a token re-save
 * landing at the same moment wins.
 */
export async function syncPairedNumber<T extends PairedRow>(
  db: SupabaseClient,
  row: T,
  livePhone: string | null | undefined
): Promise<T> {
  const patch = pairedNumberPatch(row, livePhone);
  if (!patch) return row;
  try {
    let update = db
      .from('whatsapp_config')
      .update(patch)
      .eq('id', row.id)
      .eq('account_id', row.accountId)
      .eq('provider', 'whapi');
    update = row.wabaId
      ? update.eq('waba_id', row.wabaId)
      : update.is('waba_id', null);
    const { data, error } = await update.select('id');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return row;
    console.log(
      `[channel-health] ${row.id}: paired number changed ${row.wabaId ?? '(none)'} → ${patch.waba_id}`
    );
    return { ...row, wabaId: patch.waba_id, label: patch.label ?? row.label };
  } catch (err) {
    console.error(
      `[channel-health] ${row.id}: could not store the paired number:`,
      err instanceof Error ? err.message : err
    );
    return row;
  }
}

export interface ChannelHealthSummary {
  checked: number;
  changed: number;
  notified: number;
  failed: number;
}

export interface ChannelHealthDeps {
  probe?: (channel: WhatsAppChannel) => Promise<ChannelProbe | null>;
  now?: () => Date;
  /** When each OpenWA number's run of `disconnected` began. */
  disconnectedSince?: Map<string, number>;
}

/** Probes at once — each is capped at 5s, and a tick has 60s in all. */
const PROBE_CONCURRENCY = 5;

/**
 * One sweep over every Whapi number on the install. Needs the
 * service-role client: it reads every account's rows and writes
 * notifications for users other than the caller.
 *
 * Never throws for one bad row — a number whose status write or alert
 * fails is counted in `failed`. For a status write, or a lost
 * logged-out alert, the status either never moved or was put back (see
 * `applyTransition`), so the next tick sees the same transition and
 * alerts again. A lost "connected again" alert is not retried: the
 * number keeps its new 'connected' status.
 */
export async function runChannelHealthCheck(
  admin: SupabaseClient,
  deps: ChannelHealthDeps = {}
): Promise<ChannelHealthSummary> {
  const probe = deps.probe ?? probeChannel;
  const now = deps.now ?? (() => new Date());
  const firstSeen = deps.disconnectedSince ?? disconnectedSince;
  const channels = await loadLinkedChannelsForHealth(admin);
  const probedIds = new Set(channels.map((c) => c.id));
  for (const id of firstSeen.keys()) {
    if (!probedIds.has(id)) firstSeen.delete(id);
  }
  const summary: ChannelHealthSummary = {
    checked: 0,
    changed: 0,
    notified: 0,
    failed: 0,
  };

  for (let i = 0; i < channels.length; i += PROBE_CONCURRENCY) {
    const batch = channels.slice(i, i + PROBE_CONCURRENCY);
    await Promise.all(
      batch.map(async (probed) => {
        let channel = probed;
        try {
          const outcome = await probeOutcome(probe, channel);
          if (!outcome) return;
          summary.checked++;
          // Before any alert, so it names the number now paired.
          // Whapi only: its sync write is scoped to provider = 'whapi'.
          if (outcome.ok && channel.provider === 'whapi') {
            channel = await syncPairedNumber(admin, channel, outcome.phone);
          }
          const verdict = nextHealth(
            channel.status,
            outcome,
            channel.provider,
            confirmDisconnected(firstSeen, channel, outcome, now().getTime())
          );
          if (!verdict.notify) {
            if (verdict.reason === 'inconclusive') {
              console.warn(
                `[channel-health] ${channel.id}: inconclusive probe (${verdict.detail}); status left '${channel.status}'`
              );
            }
            return;
          }
          const notified = await applyTransition(
            admin,
            channel,
            verdict,
            now(),
            outcome.ok ? outcome.phone : null
          );
          if (notified === null) return;
          summary.changed++;
          summary.notified += notified;
        } catch (err) {
          summary.failed++;
          console.error(
            `[channel-health] ${channel.id}: check failed:`,
            err instanceof Error ? err.message : err
          );
        }
      })
    );
  }

  // Abandoned OpenWA connects ride on this tick so they share its
  // throttle (both crons call it at most every 5 minutes). Each keeps a
  // headless browser running on the gateway until it is torn down.
  try {
    const swept = await sweepAbandonedOpenWASessions(admin, { now });
    if (swept.found > 0) console.log('[channel-health] openwa sweep:', swept);
  } catch (err) {
    console.error(
      '[channel-health] openwa sweep failed:',
      err instanceof Error ? err.message : err
    );
  }

  return summary;
}

/**
 * Write the new status and alert the account's owners and admins, or,
 * for a personal number (190), its holder alone.
 * Returns how many were notified, or null when another writer (an
 * overlapping tick, an admin re-saving the number) moved the row first
 * — the conditional update is what keeps two ticks from alerting twice.
 *
 * Throws when the alert could not be stored. A 'down' change is put
 * back first: a moved status with no alert is a transition nobody
 * hears of, because the next tick sees nothing to report. An 'up'
 * change is kept, because putting it back leaves a working number
 * marked disconnected — which refuses its Compass notifications and
 * warns in the composer — for as long as the alert keeps failing (every
 * tick, on a build running before migration 065). Losing the "connected
 * again" notice costs less; the owners were told it went down.
 */
async function applyTransition(
  admin: SupabaseClient,
  channel: WhatsAppChannel,
  verdict: HealthVerdict,
  at: Date,
  livePhone: string | null | undefined = null
): Promise<number | null> {
  const patch: Record<string, unknown> = { status: verdict.status };
  if (verdict.status === 'connected') patch.connected_at = at.toISOString();

  // An OpenWA row is inserted 'disconnected' while its QR waits, so the
  // first `ready` would read as "connected again — messages may be
  // missing" for a number that was never up. When this sweep sees the
  // link before the connect dialog's poll does, it stamps the first link
  // the way the status route would, number included, and tells nobody.
  // Without the number here `waba_id` stayed NULL, because the status
  // route writes status only on a first link it still sees unstamped.
  const firstLink =
    channel.provider === 'openwa' &&
    verdict.notify === 'up' &&
    channel.connectedAt === null;
  const phone = livePhone?.replace(/\D/g, '') ?? '';
  if (firstLink && phone) {
    // The status route's same-phone guard, for a link this sweep sees
    // first. A failed read throws: nothing is stamped or torn down, and
    // the next sweep asks again.
    const refusal = await phoneAlreadyConnected(
      admin,
      { id: channel.id, accountId: channel.accountId },
      phone
    );
    if (refusal) {
      console.warn(
        `[channel-health] ${channel.id}: first link refused, same phone`
      );
      await disconnectOpenWANumber(
        admin,
        channel.accountId,
        { id: channel.id, phone_number_id: channel.phoneNumberId },
        { force: true }
      );
      return null;
    }
    patch.waba_id = phone;
  }

  let update = admin
    .from('whatsapp_config')
    .update(patch)
    .eq('id', channel.id)
    .eq('account_id', channel.accountId)
    .eq('status', channel.status);
  // Lost to the status route's own first-link write: nothing left to do.
  if (firstLink) update = update.is('connected_at', null);
  const { data: moved, error: updateError } = await update.select('id');
  if (updateError) throw new Error(updateError.message);
  if (!moved || moved.length === 0) return null;

  console.log(
    `[channel-health] ${channel.id} (account ${channel.accountId}): ` +
      `${channel.status} → ${verdict.status} (${verdict.detail})` +
      (firstLink ? ', first link, no alert' : '')
  );
  if (firstLink) return 0;

  const alert = channelHealthAlert(channel, verdict);
  if (!alert) return 0;

  try {
    return await sendAlert(admin, channel, alert);
  } catch (err) {
    // Typical causes: a transient DB error, or this build running
    // before migration 065 widened the notifications type CHECK. A
    // multi-row INSERT the database refused stored nothing, so the
    // retry does not duplicate the alert; a transport error after the
    // commit can, and alerting twice is the safer failure.
    if (verdict.notify === 'down') {
      await undoTransition(admin, channel, verdict);
    } else {
      console.error(
        `[channel-health] ${channel.id}: the '${verdict.notify}' alert was not saved; status kept as '${verdict.status}', and it will not be retried`
      );
    }
    throw err;
  }
}

/**
 * Store one alert per owner and admin; a personal number's goes to its
 * holder only, who alone can re-link it. Returns how many; throws on a DB
 * error.
 */
async function sendAlert(
  admin: SupabaseClient,
  channel: WhatsAppChannel,
  alert: ChannelAlert
): Promise<number> {
  const { accountId } = channel;
  // A personal row without a holder: nobody can act on it.
  if (channel.isPersonal && !channel.personalUserId) return 0;
  const people = admin
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId);
  const { data: admins, error: profilesError } = await (
    channel.isPersonal
      ? people.eq('user_id', channel.personalUserId)
      : people.in('account_role', ['owner', 'admin'])
  )
    // Someone deactivated no longer works this account.
    .is('deactivated_at', null);
  if (profilesError) {
    throw new Error(`alert not saved: ${profilesError.message}`);
  }

  const rows = ((admins ?? []) as Array<{ user_id: string }>).map((p) => ({
    account_id: accountId,
    user_id: p.user_id,
    type: alert.type,
    conversation_id: null,
    contact_id: null,
    actor_user_id: null,
    title: alert.title,
    body: alert.body,
    // The bell sends a personal number's alert to its holder's profile
    // tab (notifications/target.ts), whatever their role.
    ...(channel.isPersonal ? { meta: { personal: true } } : {}),
  }));
  // Nobody to tell. Retrying would not change that.
  if (rows.length === 0) return 0;

  const { error: insertError } = await admin.from('notifications').insert(rows);
  if (insertError) throw new Error(`alert not saved: ${insertError.message}`);
  return rows.length;
}

/**
 * Put the status back after a transition whose alert was lost, so the
 * next tick redoes both. Conditional on the status this tick wrote: a
 * writer that has moved the row since wins. `connected_at` keeps the
 * stamp — the number was up at that moment.
 */
async function undoTransition(
  admin: SupabaseClient,
  channel: WhatsAppChannel,
  verdict: HealthVerdict
): Promise<void> {
  const { data: undone, error } = await admin
    .from('whatsapp_config')
    .update({ status: channel.status })
    .eq('id', channel.id)
    .eq('account_id', channel.accountId)
    .eq('status', verdict.status)
    .select('id');
  if (error) {
    console.error(
      `[channel-health] ${channel.id}: the alert was not saved and the status could not be put back to '${channel.status}'; this ${verdict.notify} transition will not alert again:`,
      error.message
    );
    return;
  }
  console.error(
    undone && undone.length > 0
      ? `[channel-health] ${channel.id}: the alert was not saved; status put back to '${channel.status}' so the next tick retries`
      : `[channel-health] ${channel.id}: the alert was not saved; another writer has moved the status since, so it was left as it is`
  );
}

/**
 * A once-per-interval gate, per process. For piggy-backing the check on
 * a cron that fires more often than probing is worth.
 *
 * It allows a little slack (5 s, or a tenth of a short interval): a
 * once-a-minute pinger's requests land a few milliseconds either side of
 * 60 s apart, and without slack every early one skipped a 1-minute job
 * (journey tick, phone system) until the next ping, halving its rate.
 */
export function everyInterval(intervalMs: number): (nowMs?: number) => boolean {
  const slack = Math.min(5_000, intervalMs / 10);
  let last = -Infinity;
  return (nowMs = Date.now()) => {
    if (nowMs - last < intervalMs - slack) return false;
    last = nowMs;
    return true;
  };
}
