// ============================================================
// POST /api/pbx/softphone/signature — a Linkus SDK login for the
// caller's own extension (module 015, migration 089).
//   → { username, sign, pbxUrl }
//
// Only for the caller's mapped extension (pbx_my_extension(), on their
// client; nothing in the body is read) with the softphone switched on
// for it: 409 code no_extension / softphone_disabled otherwise, and
// no_sdk_credentials when the PBX has no Linkus SDK AccessID/AccessKey.
// The signature is minted server-side with the SDK credentials; the
// response carries only the signature for that one username, never a
// stored secret or token. Agent+.
//
// The username the Cloud SDK expects is not settled by Yeastar's docs
// (the extension number, or the extension's email). It is the extension
// number; PBX_SDK_USERNAME_MODE=email sends the caller's login email
// instead, which must then match the extension's email on the PBX.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { pbxServiceDb } from '@/lib/pbx/admin';
import {
  fail,
  myExtension,
  noExtension,
  pbxFailure,
  pbxUrl,
} from '@/lib/pbx/calls';
import { sdkSignerFor } from '@/lib/pbx/connection';

export async function POST() {
  try {
    const ctx = await requireRole('agent');
    const ext = await myExtension(ctx.supabase);
    if (!ext) return noExtension();
    if (!ext.softphoneEnabled)
      return fail('The softphone is not switched on for your extension', 409, {
        code: 'softphone_disabled',
      });

    let username = ext.extension;
    if (process.env.PBX_SDK_USERNAME_MODE?.trim() === 'email') {
      const { data } = await ctx.supabase.auth.getUser();
      const email = data.user?.email?.trim();
      if (!email)
        return fail('Your login has no email address for the softphone', 409, {
          code: 'no_email',
        });
      username = email;
    }

    const signer = await sdkSignerFor(pbxServiceDb(), ext.connectionId);
    const sign = await signer.sign(username);
    return NextResponse.json(
      { username, sign, pbxUrl: pbxUrl(signer.connection.baseUrl) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return pbxFailure(err) ?? toErrorResponse(err);
  }
}
