// ============================================================
// Smart insights settings, server side (migration 147).
//
// Every Smart insights feature asks two questions before it calls Jev:
// can Jev run for this account at all (`insightsAvailable`: the layer
// is up, the server has a key, the account is in TS_ACCOUNT_IDS), and
// did an admin switch this feature on (`getInsightSettings`). Both
// answer "no" on any doubt, so a failure leaves the CRM as it was.
//
// The settings are read on the service role and cached 30 s per
// account, like the TypeSafe switches (SwitchesStore in
// lib/typesafe/policy.ts): a read error serves the last value read,
// else everything off, and the settings PUT writes the saved row
// through (`setCachedInsightSettings`), generation-checked so a read
// that started before the save cannot put the older row back.
// ============================================================

import { supabaseAdmin } from '@/lib/ai/admin-client';
import { getDecisionLayer } from '@/lib/typesafe';
import { accountEnabled } from '@/lib/typesafe/config';
import {
  INSIGHT_SETTINGS_COLUMNS,
  INSIGHT_SETTINGS_OFF,
  settingsFromRow,
  type InsightSettings,
  type InsightSettingsRow,
} from './settings-shape';

export { INSIGHT_SETTINGS_OFF, type InsightSettings } from './settings-shape';

type ReadRow = (accountId: string) => Promise<InsightSettingsRow | null>;

export class InsightSettingsStore {
  private cache = new Map<
    string,
    { at: number; ttl: number; s: InsightSettings }
  >();
  private lastGood = new Map<string, InsightSettings>();
  private generation = new Map<string, number>();

  constructor(
    private readonly deps: {
      read: ReadRow;
      ttlMs?: number;
      errorTtlMs?: number;
      now?: () => number;
      onError?: (err: unknown) => void;
    }
  ) {}

  private bump(accountId: string): void {
    this.generation.set(accountId, (this.generation.get(accountId) ?? 0) + 1);
  }

  /** The account's settings as just saved: applied here at once. */
  set(accountId: string, s: InsightSettings): void {
    this.bump(accountId);
    this.lastGood.set(accountId, s);
    this.cache.set(accountId, {
      at: (this.deps.now ?? Date.now)(),
      ttl: this.deps.ttlMs ?? 30_000,
      s,
    });
  }

  /** Never throws. */
  async get(accountId: string): Promise<InsightSettings> {
    const now = (this.deps.now ?? Date.now)();
    const hit = this.cache.get(accountId);
    if (hit && now - hit.at < hit.ttl) return hit.s;

    const gen = this.generation.get(accountId) ?? 0;
    let s: InsightSettings;
    let failed = false;
    try {
      s = settingsFromRow(await this.deps.read(accountId));
    } catch (err) {
      failed = true;
      this.deps.onError?.(err);
      s = this.lastGood.get(accountId) ?? INSIGHT_SETTINGS_OFF;
    }
    // Saved while this read was in flight: the save is newer.
    if ((this.generation.get(accountId) ?? 0) !== gen) {
      const newer = this.cache.get(accountId);
      return newer ? newer.s : s;
    }
    if (!failed) this.lastGood.set(accountId, s);
    this.cache.set(accountId, {
      at: now,
      ttl: failed
        ? (this.deps.errorTtlMs ?? 5_000)
        : (this.deps.ttlMs ?? 30_000),
      s,
    });
    return s;
  }
}

async function readRow(accountId: string): Promise<InsightSettingsRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('ai_insight_settings')
    .select(INSIGHT_SETTINGS_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as InsightSettingsRow | null) ?? null;
}

let shared: InsightSettingsStore | null = null;
function store(): InsightSettingsStore {
  shared ??= new InsightSettingsStore({
    read: readRow,
    onError: (err) =>
      console.error(
        '[insights] settings read failed:',
        err instanceof Error ? err.message : String(err)
      ),
  });
  return shared;
}

/** The account's Smart insights settings (30 s cache). Never throws. */
export function getInsightSettings(
  accountId: string
): Promise<InsightSettings> {
  return store().get(accountId);
}

/** The settings PUT writes the saved row through. */
export function setCachedInsightSettings(
  accountId: string,
  s: InsightSettings
): void {
  store().set(accountId, s);
}

/** Jev can run for this account: layer up, key set, account allowed. */
export function insightsAvailable(accountId: string): boolean {
  try {
    const ts = getDecisionLayer();
    if (!ts || !ts.gateway.hasKey()) return false;
    return accountEnabled(ts.config, accountId);
  } catch {
    return false;
  }
}
