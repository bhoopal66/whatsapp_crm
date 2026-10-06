import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/provider'
import { loadChannels, primaryChannel } from '@/lib/whatsapp/channels'
import { mediaResponseHeaders } from '@/lib/whatsapp/media-headers'

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
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
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
    // replaying an id. The LIKE repeats the partial index's predicate
    // (migration 062) so the lookup is an index probe, not a scan.
    const proxyPath = `/api/whatsapp/media/${mediaId}`
    const { data: owningMessage } = await supabase
      .from('messages')
      .select('id, channel_id, provider')
      .eq('media_url', proxyPath)
      .like('media_url', '/api/whatsapp/media/%')
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

    // A media id is opaque and belongs to whichever gateway issued it,
    // and nothing in the URL says which. With a handful of connected
    // channels, trying each (primary first) is simpler and more robust
    // than threading a provider through every caller — and in the
    // common single-channel case it is exactly one attempt.
    //
    // The message says which number carried it (060+), so that one is
    // tried first — usually the only attempt with several numbers.
    const carrier = owningMessage.channel_id
      ? channels.find((c) => c.id === owningMessage.channel_id)
      : undefined
    const first = carrier ?? primaryChannel(channels)!
    const ordered = [first, ...channels.filter((c) => c.id !== first.id)]

    let resolved: { buffer: Buffer; contentType: string; mimeType: string } | null =
      null
    let lastError: unknown = null

    for (const channel of ordered) {
      try {
        const mediaInfo = await getMediaUrl({ channel, mediaId })
        // Gateway-hosted media needs the channel's own token presented
        // as a Bearer header, so the download goes back through the
        // same channel that resolved the id.
        const { buffer, contentType } = await downloadMedia({
          channel,
          downloadUrl: mediaInfo.url,
        })
        resolved = { buffer, contentType, mimeType: mediaInfo.mimeType }
        break
      } catch (err) {
        lastError = err
      }
    }

    if (!resolved) throw lastError ?? new Error('Media could not be resolved')
    const { buffer, contentType, mimeType } = resolved

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: mediaResponseHeaders(contentType || mimeType),
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
