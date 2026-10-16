// ============================================================
// /api/whatsapp/groups/[id]/icon — a group's picture (114).
// GET streams the image through us (Whapi's CDN link expires and the
// token must stay server-side) to anyone who can see the group. PUT
// (multipart `file`, JPEG/PNG up to 2 MB) and DELETE are managers'
// and need our number to be a group admin.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import {
  checkIconUpload,
  requireGroupAdmin,
} from '@/lib/groups/member-requests';
import {
  channelForGroup,
  GroupHttpError,
  groupErrorResponse,
  loadGroupForCaller,
} from '@/lib/groups/server';
import { deleteIcon, getIcon, setIcon } from '@/lib/whatsapp/groups';

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

const noIcon = () => new GroupHttpError(404, 'no_icon', 'No group picture');

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const group = await loadGroupForCaller(ctx, id);
    if (!group.channel_id) throw noIcon();
    const channel = await channelForGroup(group);
    const icon = await getIcon({ channel, groupId: group.wa_group_id });
    if (!icon) throw noIcon();
    // The bytes come from the gateway: only an image is passed through.
    if (!icon.contentType.toLowerCase().startsWith('image/')) throw noIcon();
    return new NextResponse(icon.bytes, {
      headers: {
        'Content-Type': icon.contentType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
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
    const ctx = await getCurrentAccount();
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
