/**
 * Pin a chat's sending number (migration 061), or `null` for automatic,
 * through `PUT /api/whatsapp/conversations/[id]/channel`. Shared by the
 * thread header's switcher and the new chat reminder's switch button.
 * `error` is the server's message when it gave one; the caller words
 * the toast.
 */
export async function putConversationSendChannel(
  conversationId: string,
  channelId: string | null
): Promise<{ ok: true } | { ok: false; error: string | null }> {
  try {
    const res = await fetch(
      `/api/whatsapp/conversations/${conversationId}/channel`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_id: channelId }),
      }
    );
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    return {
      ok: false,
      error: typeof body?.error === 'string' && body.error ? body.error : null,
    };
  } catch {
    return { ok: false, error: null };
  }
}
