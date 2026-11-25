// ============================================================
// /api/whatsapp/groups/[id]/icon — a group's picture (114).
// GET streams the image through us (Whapi's CDN link expires and the
// token must stay server-side) to anyone who can see the group. PUT
// (multipart `file`, JPEG/PNG up to 2 MB) and DELETE are managers'
// and need our number to be a group admin.
// ============================================================

import { NextResponse } from 'next/server';

import { assertSalesAccess, getCurrentAccount } from '@/lib/auth/account';
import {
  checkIconUpload,
  requireGroupAdmin,
} from '@/lib/groups/member-requests';
import {
  channelForGroup,
  groupErrorResponse,
  loadGroupForCaller,
} from '@/lib/groups/server';
import {
  deleteIcon,
  describeGroupFailure,
  getIcon,
  setIcon,
} from '@/lib/whatsapp/groups';
import { inlineImageType } from '@/lib/whatsapp/media-headers';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/**
 * A 404, so the <img> falls back to initials. Kept by the browser for an
 * hour: every avatar shown is otherwise one gateway call.
 */
const noIcon = (cacheable: boolean) =>
  NextResponse.json(
    { error: 'No group picture', code: 'no_icon' },
    {
      status: 404,
      headers: {
        'Cache-Control': cacheable ? 'private, max-age=3600' : 'no-store',
      },
    }
  );

export async function GET(request: Request, { params }: Params) {
  // `v` counts the changes made on one screen and starts over on the next
  // visit: an answer for 1 kept from before would hide a new picture.
  const v = new URL(request.url).searchParams.get('v');
  const cacheable = v === null || v === '0';
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const group = await loadGroupForCaller(ctx, id);
    if (!group.channel_id) return noIcon(cacheable);
    const channel = await channelForGroup(group);
    const icon = await getIcon({
      channel,
      groupId: group.wa_group_id,
    }).catch((err) => {
      // A gateway's 404 for the picture is no picture either.
      if (describeGroupFailure(err) === 'group_not_found') return null;
      throw err;
    });
    if (!icon) return noIcon(cacheable);
    // The bytes come from the gateway: only a raster image is passed
    // through. An SVG is a document that runs script when the link is
    // opened on our origin, whatever nosniff says.
    const type = inlineImageType(icon.contentType);
    if (!type) return noIcon(cacheable);
    return new NextResponse(icon.bytes, {
      headers: {
        'Content-Type': type,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': cacheable ? 'private, max-age=300' : 'no-store',
      },
    });
  } catch (err) {
    // next.config.ts leaves this path's header to the route.
    const res = groupErrorResponse(err);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const form = await request.formData().catch(() => null);
    const { mimeType } = checkIconUpload(form?.get('file') ?? null);
    const file = form!.get('file') as Blob;
    const group = await loadGroupForCaller(ctx, id, { manage: true });
    requireGroupAdmin(group);
    const channel = await channelForGroup(group);
    const base64 = Buffer.from(await file.arrayBuffer()).toString('base64');
    await setIcon({
      channel,
      groupId: group.wa_group_id,
      media: `data:${mimeType};base64,${base64}`,
      mimeType,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = assertSalesAccess(await getCurrentAccount());
    const { id } = await params;
    const group = await loadGroupForCaller(ctx, id, { manage: true });
    requireGroupAdmin(group);
    const channel = await channelForGroup(group);
    await deleteIcon({ channel, groupId: group.wa_group_id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return groupErrorResponse(err);
  }
}
