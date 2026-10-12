// ============================================================
// GET /api/pbx/me — the caller's phone in the active workspace (module
// 015, migration 089).
//   → { extension, connectionId, softphoneEnabled, softphoneAvailable,
//       pbxUrl } | { extension: null }
//
// The mapping is pbx_my_extension() on the caller's client (agent and
// up; a viewer has none). softphoneAvailable says whether the PBX has
// Linkus SDK credentials stored; the secrets table is read on the
// service role for that one yes/no, and nothing in it is returned.
// pbxUrl is the PBX's address, which the Linkus SDK connects to.
// Viewer+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { pbxServiceDb } from '@/lib/pbx/admin';
import { myExtension, pbxUrl } from '@/lib/pbx/calls';

export async function GET() {
  try {
    const ctx = await requireRole('viewer');
    const ext = await myExtension(ctx.supabase);
    if (!ext) return NextResponse.json({ extension: null });

    const db = pbxServiceDb();
    const [conn, secrets] = await Promise.all([
      db
        .from('pbx_connections')
        .select('base_url')
        .eq('id', ext.connectionId)
        .maybeSingle(),
      db
        .from('pbx_connection_secrets')
        .select('sdk_access_id_enc, sdk_access_key_enc')
        .eq('connection_id', ext.connectionId)
        .maybeSingle(),
    ]);
    if (conn.error)
      throw new Error(`pbx_connections read failed: ${conn.error.message}`);
    if (secrets.error)
      throw new Error(`PBX secrets read failed: ${secrets.error.message}`);
    const row = conn.data as { base_url: string } | null;
    if (!row) return NextResponse.json({ extension: null });
    const s = secrets.data as {
      sdk_access_id_enc: string | null;
      sdk_access_key_enc: string | null;
    } | null;

    return NextResponse.json({
      extension: ext.extension,
      connectionId: ext.connectionId,
      softphoneEnabled: ext.softphoneEnabled,
      softphoneAvailable: Boolean(s?.sdk_access_id_enc && s.sdk_access_key_enc),
      pbxUrl: pbxUrl(row.base_url),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
