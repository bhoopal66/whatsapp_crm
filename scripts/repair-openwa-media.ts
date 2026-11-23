/**
 * Repair inbound OpenWA attachments mirrored before `mirrorKey`
 * (`src/lib/whatsapp/mirror-inbound-media.ts`): every attachment of one
 * chat with the same extension went to ONE chat-media object, each upload
 * overwriting the last, so all of them opened as the latest file.
 *
 *   npx tsx scripts/repair-openwa-media.ts [--apply]
 *
 *   (default)  dry run: fetch each affected message's own file from
 *              OpenWA, check the NAS archive copies, print the plan.
 *              Writes nothing.
 *   --apply    upload each file to its own object and point the message
 *              at it (only if the link is still the shared one); then,
 *              with the NAS copier stopped, re-point the archive rows,
 *              reset the ones copied from the wrong bytes, move wrong
 *              NAS copies to `<root>/.repair-2026-11-17/<ref>/`, and
 *              start the copier again. It re-copies the reset rows.
 *
 * Affected = a message still on an `/inbound/` object named the old
 * OpenWA way (shared or not), on an OpenWA number. Downloads are paced
 * for OpenWA's rate limit. A message whose file OpenWA no longer
 * has is listed and left alone. Tokens and URLs are never printed.
 *
 * Reads `.env.local` (Supabase, ENCRYPTION_KEY, OPENWA_URL). Archive
 * writes go through `docker exec supabase-db psql` because the service
 * role may only read `customer_documents`. Run as root on the host.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

try {
  process.loadEnvFile('.env.local');
} catch {
  // No file: the environment already carries the settings.
}

const USAGE =
  'usage: npx tsx scripts/repair-openwa-media.ts [--contact <name or company>] [--apply]';
const PAGE = 1000;
const CHUNK = 100;
const QUARANTINE = '.repair-2026-11-17';
const REF_RE = /^TC-[0-9]{6,}$/;
const DOC_WORKER = 'wacrm-customer-docs.service';

type Msg = {
  id: string;
  channel_id: string | null;
  message_id: string | null;
  media_url: string;
  media_type: string | null;
  content_type: string;
  content_text: string | null;
  created_at: string;
};

type Fixed = Msg & { realSha: string; newUrl: string | null };

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** `account-<id>/inbound/<digits>_lid_false_…`: the pre-`mirrorKey` cut. */
function isOldOpenwaObject(url: string): boolean {
  return /\/inbound\/[0-9]+_(?:lid|c_us|g_us)_(?:true|false)_[^/]*$/.test(url);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

/**
 * OpenWA allows 10 requests a second and 100 a minute, and the live app
 * needs the same gateway for incoming media: one download per 1.5 s, and
 * a 429 waits 30 s and tries again (5 times).
 */
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const wait = lastCall + 1500 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt >= 5 || !/\b429\b/.test(msg)) throw e;
      console.log(`  (OpenWA busy, waiting 30 s, try ${attempt + 1}/5)`);
      await sleep(30_000);
    }
  }
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function fileSha(path: string): Promise<string | null> {
  try {
    return sha(await readFile(path));
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  // --contact <text>: only chats of contacts whose name or company
  // contains <text> (case-insensitive).
  const ci = args.indexOf('--contact');
  const contactFilter = ci >= 0 ? (args[ci + 1] ?? '').trim() : null;
  if (
    contactFilter !== null &&
    !/^[\p{L}\p{N} .&-]{3,60}$/u.test(contactFilter)
  ) {
    console.error('--contact needs 3-60 letters, digits or spaces');
    process.exit(2);
  }
  const unknown = args.filter(
    (a, i) => a !== '--apply' && a !== '--contact' && !(ci >= 0 && i === ci + 1)
  );
  if (unknown.length || args.includes('--help')) {
    console.log(USAGE);
    process.exit(unknown.length ? 2 : 0);
  }
  const apply = args.includes('--apply');

  // Imported after loadEnv: encryption.ts reads ENCRYPTION_KEY at load.
  const { createClient } = await import('@supabase/supabase-js');
  const { loadChannels } = await import('../src/lib/whatsapp/channels');
  const provider = await import('../src/lib/whatsapp/provider');
  const { mirrorInboundMedia } =
    await import('../src/lib/whatsapp/mirror-inbound-media');
  const { openwaMediaIdFor, planDocRepair, sqlLiteral } =
    await import('../src/lib/whatsapp/media-collision-repair');

  const url =
    process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase URL and service key required');
  const db = createClient(url, key, { auth: { persistSession: false } });
  const nasRoot =
    process.env.CUSTOMER_DOCS_NAS_ROOT || '/mnt/nas-share/Customer Documents';

  // Optional scope: the conversations of the matching contacts.
  let conversationIds: string[] | null = null;
  if (contactFilter) {
    const pat = `%${contactFilter}%`;
    const { data: cs, error: cErr } = await db
      .from('contacts')
      .select('id, name, company')
      .or(`name.ilike.${pat},company.ilike.${pat}`);
    if (cErr) throw new Error(`contacts: ${cErr.message}`);
    for (const c of cs ?? [])
      console.log(`contact ${c.id}: ${c.name ?? ''} / ${c.company ?? ''}`);
    const { data: cv, error: vErr } = await db
      .from('conversations')
      .select('id')
      .in(
        'contact_id',
        (cs ?? []).map((c) => c.id as string)
      );
    if (vErr) throw new Error(`conversations: ${vErr.message}`);
    conversationIds = (cv ?? []).map((c) => c.id as string);
    console.log(`${conversationIds.length} conversation(s) in scope`);
    if (!conversationIds.length) return;
  }

  // 1. Messages on a shared inbound object.
  const all: Msg[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = db
      .from('messages')
      .select(
        'id, channel_id, message_id, media_url, media_type, content_type, content_text, created_at'
      )
      .like('media_url', '%/chat-media/%/inbound/%');
    if (conversationIds) q = q.in('conversation_id', conversationIds);
    const { data, error } = await q.order('id').range(from, from + PAGE - 1);
    if (error) throw new Error(`messages: ${error.message}`);
    all.push(...(data as Msg[]));
    if (!data || data.length < PAGE) break;
  }
  // Affected = still on an object named the old OpenWA way (the 40-char
  // cut of `<chat>/<message id>`), shared or not: a group a previous run
  // only partly repaired leaves its last message unshared but still on
  // the overwritten object. Whapi and Meta names (`pdf-<hex>-…`, digits)
  // are unique per media item, so a shared one is the same file twice.
  const affected = all.filter((m) => isOldOpenwaObject(m.media_url));
  const objects = new Set(affected.map((m) => m.media_url)).size;
  console.log(
    `${all.length} mirrored inbound messages; ${affected.length} on ${objects} old OpenWA objects`
  );

  // 2. Their channels, decrypted.
  type Channel = Awaited<ReturnType<typeof loadChannels>>[number];
  const channels = new Map<string, Channel>();
  const channelIds = [
    ...new Set(affected.map((m) => m.channel_id).filter(Boolean)),
  ] as string[];
  const { data: cfg, error: cfgErr } = await db
    .from('whatsapp_config')
    .select('id, account_id')
    .in('id', channelIds);
  if (cfgErr) throw new Error(`whatsapp_config: ${cfgErr.message}`);
  for (const accountId of new Set(
    (cfg ?? []).map((r) => r.account_id as string)
  )) {
    for (const c of await loadChannels(db, accountId)) channels.set(c.id, c);
  }

  // 3. Fetch each message's own file again.
  const fixed: Fixed[] = [];
  const skipped: string[] = [];
  for (const m of affected) {
    const channel = m.channel_id ? channels.get(m.channel_id) : undefined;
    const mediaId = m.message_id ? openwaMediaIdFor(m.message_id) : null;
    const label = `${m.id} ${m.created_at.slice(0, 16)} ${m.content_type} ${(m.content_text ?? '').slice(0, 40)}`;
    if (!channel || channel.provider !== 'openwa' || !mediaId) {
      skipped.push(`${label}: not an OpenWA message id/number`);
      continue;
    }
    try {
      const info = await provider.getMediaUrl({ channel, mediaId });
      const { buffer, contentType } = await paced(() =>
        provider.downloadMedia({ channel, downloadUrl: info.url })
      );
      let newUrl: string | null = null;
      if (apply) {
        const isFile =
          m.content_type === 'document' &&
          /\.[A-Za-z0-9]{1,8}$/.test(m.content_text ?? '');
        newUrl = await mirrorInboundMedia({
          storage: db.storage,
          accountId: channel.accountId,
          mediaId,
          downloadUrl: info.url,
          accessToken: channel.accessToken,
          download: async () => ({ buffer, contentType }),
          mimeType: m.media_type ?? info.mimeType,
          fileName: isFile ? m.content_text : null,
          messageTimestamp: Math.floor(Date.parse(m.created_at) / 1000),
        });
        if (!newUrl) {
          skipped.push(`${label}: upload refused`);
          continue;
        }
        if (newUrl === m.media_url) {
          skipped.push(`${label}: new object equals the shared one`);
          continue;
        }
        const { data: upd, error } = await db
          .from('messages')
          .update({ media_url: newUrl })
          .eq('id', m.id)
          .eq('media_url', m.media_url)
          .select('id');
        if (error || !upd?.length) {
          skipped.push(`${label}: link changed meanwhile or update failed`);
          continue;
        }
      }
      fixed.push({ ...m, realSha: sha(buffer), newUrl });
      console.log(`  ok  ${label} (${buffer.byteLength} bytes)`);
    } catch (e) {
      skipped.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(
    `\n${fixed.length} messages ${apply ? 'repaired' : 'recoverable'}, ${skipped.length} left alone`
  );
  for (const s of skipped) console.log(`  skip ${s}`);

  // 4. NAS archive rows of those messages.
  const byMsg = new Map(fixed.map((f) => [f.id, f]));
  type Doc = {
    id: string;
    message_id: string;
    folder_id: string;
    status: 'pending' | 'stored' | 'duplicate' | 'failed';
    sha256: string | null;
    nas_name: string | null;
    media_url: string;
  };
  const docs: Doc[] = [];
  for (const ids of chunks([...byMsg.keys()], CHUNK)) {
    const { data, error } = await db
      .from('customer_documents')
      .select('id, message_id, folder_id, status, sha256, nas_name, media_url')
      .in('message_id', ids);
    if (error) throw new Error(`customer_documents: ${error.message}`);
    docs.push(...(data as Doc[]));
  }
  const refs = new Map<string, string>();
  for (const ids of chunks([...new Set(docs.map((d) => d.folder_id))], CHUNK)) {
    const { data, error } = await db
      .from('customer_doc_folders')
      .select('id, ref')
      .in('id', ids);
    if (error) throw new Error(`customer_doc_folders: ${error.message}`);
    for (const r of data ?? []) refs.set(r.id as string, r.ref as string);
  }

  const sql: string[] = [];
  const moves: { from: string; to: string }[] = [];
  const counts = { keep: 0, reset: 0, quarantine: 0 };
  const resetIds: string[] = [];
  for (const d of docs) {
    const f = byMsg.get(d.message_id)!;
    const ref = refs.get(d.folder_id) ?? '';
    const safeName =
      d.nas_name && !/[\\/]/.test(d.nas_name) && REF_RE.test(ref);
    const path = safeName ? join(nasRoot, ref, d.nas_name!) : null;
    const nasSha = d.status === 'stored' && path ? await fileSha(path) : null;
    const plan = planDocRepair(d, f.realSha, nasSha);
    counts[plan]++;
    console.log(
      `  doc ${d.id} ${ref} ${d.status} "${d.nas_name ?? ''}" -> ${plan}`
    );
    const newUrl = f.newUrl ?? '<new link>';
    const guard = `WHERE id = ${sqlLiteral(d.id)} AND media_url = ${sqlLiteral(d.media_url)}`;
    if (plan === 'keep') {
      sql.push(
        `UPDATE public.customer_documents SET media_url = ${sqlLiteral(newUrl)} ${guard};`
      );
    } else {
      resetIds.push(d.id);
      sql.push(
        `UPDATE public.customer_documents SET media_url = ${sqlLiteral(newUrl)}, status = 'pending', sha256 = NULL, size_bytes = NULL, nas_name = NULL, duplicate_of = NULL, stored_at = NULL, attempts = 0, next_attempt_at = now(), claimed_at = NULL, last_error = NULL ${guard};`
      );
      if (plan === 'quarantine' && path) {
        moves.push({
          from: path,
          to: join(nasRoot, QUARANTINE, ref, d.nas_name!),
        });
      }
    }
  }
  // Duplicates elsewhere that point at a row being reset named its file.
  if (resetIds.length) {
    sql.push(
      `UPDATE public.customer_documents SET status = 'pending', sha256 = NULL, size_bytes = NULL, nas_name = NULL, duplicate_of = NULL, stored_at = NULL, attempts = 0, next_attempt_at = now(), claimed_at = NULL, last_error = NULL WHERE status = 'duplicate' AND duplicate_of IN (${resetIds.map(sqlLiteral).join(', ')});`
    );
  }
  console.log(
    `\narchive rows: ${docs.length} (keep ${counts.keep}, re-copy ${counts.reset}, wrong NAS file moved aside + re-copy ${counts.quarantine})`
  );

  if (!apply) {
    console.log('\nDry run: nothing written. Re-run with --apply.');
    return;
  }
  if (!sql.length) return;

  // 5. Archive: copier stopped, rows first (one transaction), then moves.
  const systemctl = (verb: string) =>
    spawnSync('systemctl', [verb, DOC_WORKER], { stdio: 'inherit' }).status;
  if (systemctl('stop') !== 0) throw new Error(`could not stop ${DOC_WORKER}`);
  try {
    const run = spawnSync(
      'docker',
      [
        'exec',
        '-i',
        'supabase-db',
        'psql',
        '-U',
        'postgres',
        '-q',
        '-1',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      { input: sql.join('\n') + '\n', encoding: 'utf8' }
    );
    if (run.status !== 0) {
      throw new Error(
        `archive update failed, nothing moved: ${run.stderr.slice(0, 500)}`
      );
    }
    for (const mv of moves) {
      try {
        await mkdir(join(mv.to, '..'), { recursive: true });
        let to = mv.to;
        for (
          let i = 2;
          await stat(to).then(
            () => true,
            () => false
          );
          i++
        ) {
          to = mv.to.replace(/(\.[^./]+)?$/, ` (${i})$1`);
        }
        await rename(mv.from, to);
      } catch (e) {
        console.log(
          `  could not move ${mv.from}: ${e instanceof Error ? e.message : e}`
        );
      }
    }
    console.log(
      `archive rows updated; ${moves.length} wrong NAS copies moved to "${join(nasRoot, QUARANTINE)}"`
    );
  } finally {
    systemctl('start');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
