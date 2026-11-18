/**
 * Fetch again, from the OpenWA gateway, the file of inbound OpenWA
 * messages that were stored without one (`media_url` NULL): before
 * migration 209 the chat-media bucket refused archives such as zip, the
 * mirror returned null and the message kept no file to open.
 *
 *   npx tsx scripts/remirror-openwa-media.ts <message uuid>… [--apply]
 *
 *   (default)  dry run: fetch each file and print its size. Writes nothing.
 *   --apply    store it in chat-media and point the message at it (only
 *              while its media_url is still NULL).
 *
 * Messages are named one by one on purpose: a lost file is restored only
 * after someone has looked at what it is. Tokens and URLs are never
 * printed. Reads `.env.local`; run on the host after migration 209.
 */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

const USAGE =
  'usage: npx tsx scripts/remirror-openwa-media.ts <message uuid>... [--apply]';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const ids = args.filter((a) => a !== '--apply');
  if (!ids.length || ids.some((id) => !UUID_RE.test(id))) {
    console.error(USAGE);
    process.exit(2);
  }

  // Imported after loadEnv: encryption.ts reads ENCRYPTION_KEY at load.
  const { createClient } = await import('@supabase/supabase-js');
  const { loadChannels } = await import('../src/lib/whatsapp/channels');
  const provider = await import('../src/lib/whatsapp/provider');
  const { mirrorInboundMedia } =
    await import('../src/lib/whatsapp/mirror-inbound-media');
  const { openwaMediaIdFor } =
    await import('../src/lib/whatsapp/media-collision-repair');

  const url =
    process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase URL and service key required');
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: msgs, error } = await db
    .from('messages')
    .select(
      'id, channel_id, message_id, media_url, media_type, content_type, content_text, created_at, provider, sender_type'
    )
    .in('id', ids);
  if (error) throw new Error(`messages: ${error.message}`);

  let failed = 0;
  for (const id of ids) {
    const m = (msgs ?? []).find((r) => r.id === id);
    const label = m
      ? `${m.id} ${String(m.created_at).slice(0, 16)} ${m.content_type} ${(m.content_text ?? '').slice(0, 50)}`
      : id;
    if (!m) {
      console.log(`  skip ${label}: no such message`);
      failed++;
      continue;
    }
    if (m.media_url) {
      console.log(`  skip ${label}: already has a file`);
      continue;
    }
    if (m.provider !== 'openwa' || m.sender_type !== 'customer') {
      console.log(`  skip ${label}: not an inbound OpenWA message`);
      failed++;
      continue;
    }
    const mediaId = m.message_id ? openwaMediaIdFor(m.message_id) : null;
    const { data: cfg } = await db
      .from('whatsapp_config')
      .select('account_id')
      .eq('id', m.channel_id)
      .maybeSingle();
    const channel = cfg
      ? (await loadChannels(db, cfg.account_id as string)).find(
          (c) => c.id === m.channel_id
        )
      : undefined;
    if (!channel || channel.provider !== 'openwa' || !mediaId) {
      console.log(`  skip ${label}: its OpenWA number or media id is gone`);
      failed++;
      continue;
    }
    try {
      const info = await provider.getMediaUrl({ channel, mediaId });
      const { buffer, contentType } = await provider.downloadMedia({
        channel,
        downloadUrl: info.url,
      });
      if (!apply) {
        console.log(`  ok   ${label}: ${buffer.byteLength} bytes (dry run)`);
        continue;
      }
      const isFile =
        m.content_type === 'document' &&
        /\.[A-Za-z0-9]{1,8}$/.test(m.content_text ?? '');
      const newUrl = await mirrorInboundMedia({
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
        console.log(`  FAIL ${label}: storage refused it (is 209 applied?)`);
        failed++;
        continue;
      }
      const { data: upd, error: uErr } = await db
        .from('messages')
        .update({ media_url: newUrl })
        .eq('id', m.id)
        .is('media_url', null)
        .select('id');
      if (uErr || !upd?.length) {
        console.log(
          `  FAIL ${label}: message changed meanwhile or update failed`
        );
        failed++;
        continue;
      }
      console.log(`  ok   ${label}: ${buffer.byteLength} bytes, restored`);
    } catch (e) {
      console.log(
        `  FAIL ${label}: ${e instanceof Error ? e.message.slice(0, 160) : 'download failed'}`
      );
      failed++;
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
