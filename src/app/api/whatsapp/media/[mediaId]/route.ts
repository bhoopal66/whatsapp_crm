import { pickActiveProfile } from '@/lib/auth/active-profile'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMediaUrl, streamMedia } from '@/lib/whatsapp/provider'
import {
  BodyTooLargeError,
  WHATSAPP_MAX_FILE_BYTES,
} from '@/lib/media/capped-body'
import { loadChannels, primaryChannel } from '@/lib/whatsapp/channels'
import { mediaResponseHeaders } from '@/lib/whatsapp/media-headers'
import {
  authUnavailableResponse,
  isAuthUnavailable,
} from '@/lib/auth/auth-unavailable';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (isAuthUnavailable(authError)) return authUnavailableResponse()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profileRows } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', user.id)
    const profile = pickActiveProfile(profileRows)
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // Only media a message the caller can SEE points at. RLS on
    // `messages` (042–044/060–062) decides; without this any member —
    // a viewer, an agent confined to their own chats — could pull any
    // attachment through the account's gateway tokens by guessing or
    // replaying an id. Only a customer's message counts: the proxy path is
    // stored on inbound media alone, while a row a person writes as their
    // own sent message could name any id. The LIKE repeats the partial index's predicate
    // (migration 062) so the lookup is an index probe, not a scan.
    const proxyPath = `/api/whatsapp/media/${mediaId}`
    const { data: owningMessage } = await supabase
      .from('messages')
      .select('id, channel_id, provider')
      .eq('media_url', proxyPath)
      .like('media_url', '/api/whatsapp/media/%')
      .eq('sender_type', 'customer')
      .limit(1)
      .maybeSingle()
    if (!owningMessage) {
      return NextResponse.json({ error: 'Media not found' }, { status: 404 })
    }

    const channels = await loadChannels(supabase, accountId)
    if (channels.length === 0) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    // A media id is opaque and belongs to whichever gateway issued it. The
    // message says which number carried it (060+): that number's token is
    // the only one that may ask for it. A row from before that names none,
    // and nothing in the URL does either, so each number is tried, the
    // primary first (null when every number is personal: then any will do
    // as the first attempt).
    const fallbackFirst = primaryChannel(channels) ?? channels[0]
    const ordered = owningMessage.channel_id
      ? channels.filter((c) => c.id === owningMessage.channel_id)
      : [
          fallbackFirst,
          ...channels.filter((c) => c.id !== fallbackFirst.id),
        ]
    if (ordered.length === 0) {
      return NextResponse.json({ error: 'Media not found' }, { status: 404 })
    }

    let resolved:
      | (Awaited<ReturnType<typeof streamMedia>> & { mimeType: string })
      | null = null
    let lastError: unknown = null

    for (const channel of ordered) {
      try {
        const mediaInfo = await getMediaUrl({ channel, mediaId })
        // Gateway-hosted media needs the channel's own token presented
        // as a Bearer header, so the download goes back through the
        // same channel that resolved the id.
        // Streamed on: a document can be 100 MB.
        const media = await streamMedia({
          channel,
          downloadUrl: mediaInfo.url,
          maxBytes: WHATSAPP_MAX_FILE_BYTES,
        })
        resolved = { ...media, mimeType: mediaInfo.mimeType }
        break
      } catch (err) {
        lastError = err
        if (err instanceof BodyTooLargeError) break
      }
    }

    if (!resolved) throw lastError ?? new Error('Media could not be resolved')
    const { body, contentType, contentLength, mimeType } = resolved

    const headers: Record<string, string> = mediaResponseHeaders(
      contentType || mimeType
    )
    if (contentLength !== null) headers['Content-Length'] = String(contentLength)
    return new Response(body, { status: 200, headers })
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return NextResponse.json(
        { error: 'This file is too large to open' },
        { status: 413 }
      )
    }
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
