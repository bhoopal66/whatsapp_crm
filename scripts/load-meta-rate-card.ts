/**
 * Load Meta's published WhatsApp rate card into `whatsapp_rate_card`
 * (migration 051), so every delivered message resolves to a cost.
 *
 *   npx tsx scripts/load-meta-rate-card.ts <card.csv> [--dry-run]
 *
 * Migration 051 seeds only a verified GCC subset; every other
 * (market, category) pair costs as NULL — visible in Settings →
 * Message costs as "no rate on file" — until the official card is
 * loaded. Export Meta's rate-card sheet to CSV with these columns
 * (header names are case-insensitive; extra columns are ignored):
 *
 *   market,category,rate_usd,effective_from
 *
 *   market          the code `whatsapp_market_prefix` maps numbers to
 *                   ('AE', 'SA', 'OTHER_ME', …). Meta's display names
 *                   are translated by MARKET_ALIASES below — extend it
 *                   when the sheet uses a name that is not listed.
 *   category        marketing | marketing_lite | utility |
 *                   authentication | authentication_international |
 *                   service | referral_conversion (hyphens and spaces
 *                   are normalised to underscores)
 *   rate_usd        e.g. 0.0576
 *   effective_from  YYYY-MM-DD (e.g. 2026-10-01)
 *
 * Idempotent: an existing (market, category, effective_from) row is
 * overwritten with the CSV value and marked source='meta-csv'. Rows
 * already in the ledger are NOT re-costed — the rate is captured at
 * delivery time — so load the card before the month it applies to.
 *
 * Reads `.env.local` for the Supabase URL and service-role key; the
 * table is written only by the service role.
 */
import { config as loadEnv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

loadEnv({ path: '.env.local' });

const MARKET_ALIASES: Record<string, string> = {
  'united arab emirates': 'AE',
  uae: 'AE',
  'saudi arabia': 'SA',
  kuwait: 'KW',
  oman: 'OM',
  'rest of middle east': 'OTHER_ME',
  'other middle east': 'OTHER_ME',
  'rest of asia pacific': 'OTHER_APAC',
  'other asia pacific': 'OTHER_APAC',
  india: 'IN',
  pakistan: 'PK',
  egypt: 'EG',
  morocco: 'MA',
  'united kingdom': 'GB',
  'north america': 'NA_US_CA',
};

const CATEGORIES = new Set([
  'marketing',
  'marketing_lite',
  'utility',
  'authentication',
  'authentication_international',
  'service',
  'referral_conversion',
]);

interface RateRow {
  market: string;
  category: string;
  rate_usd: number;
  effective_from: string;
  source: 'meta-csv';
  loaded_at: string;
}

/** Minimal CSV reader — quoted fields with commas, CRLF, a BOM. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

export function parseRateCard(text: string): RateRow[] {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error('empty CSV');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`CSV is missing the "${name}" column`);
    return i;
  };
  const iMarket = col('market');
  const iCategory = col('category');
  const iRate = col('rate_usd');
  const iFrom = col('effective_from');

  const out: RateRow[] = [];
  const loadedAt = new Date().toISOString();
  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    const rawMarket = (r[iMarket] ?? '').trim();
    const market =
      MARKET_ALIASES[rawMarket.toLowerCase()] ?? rawMarket.toUpperCase();
    const category = (r[iCategory] ?? '')
      .trim()
      .toLowerCase()
      .replace(/[-\s]+/g, '_');
    const rate = Number((r[iRate] ?? '').trim());
    const from = (r[iFrom] ?? '').trim();

    if (!market) throw new Error(`line ${line}: empty market`);
    if (!CATEGORIES.has(category))
      throw new Error(`line ${line}: unknown category "${r[iCategory]}"`);
    if (!Number.isFinite(rate) || rate < 0)
      throw new Error(`line ${line}: bad rate_usd "${r[iRate]}"`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from))
      throw new Error(
        `line ${line}: effective_from must be YYYY-MM-DD, got "${from}"`
      );

    out.push({
      market,
      category,
      rate_usd: rate,
      effective_from: from,
      source: 'meta-csv',
      loaded_at: loadedAt,
    });
  });
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const path = args.find((a) => !a.startsWith('--'));
  if (!path) {
    console.error(
      'usage: npx tsx scripts/load-meta-rate-card.ts <card.csv> [--dry-run]'
    );
    process.exit(2);
  }

  const rows = parseRateCard(readFileSync(path, 'utf8'));
  console.log(`parsed ${rows.length} rate rows from ${path}`);
  if (dryRun) {
    for (const r of rows) {
      console.log(
        `  ${r.market.padEnd(10)} ${r.category.padEnd(28)} ${r.rate_usd.toFixed(4)}  from ${r.effective_from}`
      );
    }
    return;
  }

  const url =
    process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      'NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_INTERNAL_URL) and SUPABASE_SERVICE_ROLE_KEY are required'
    );
    process.exit(2);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  // One upsert per batch; the PK is (market, category, effective_from).
  const { error } = await supabase
    .from('whatsapp_rate_card')
    .upsert(rows, { onConflict: 'market,category,effective_from' });
  if (error) {
    console.error('upsert failed:', error.message);
    process.exit(1);
  }
  console.log(`loaded ${rows.length} rate rows into whatsapp_rate_card`);
}

// Only run when invoked directly, so the parser can be imported by tests.
if (process.argv[1] && /load-meta-rate-card\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
