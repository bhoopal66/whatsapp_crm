/**
 * The number a reply typed in the inbox will go out on, as far as the
 * browser can tell. It is used to warn the agent before they write a
 * reply that cannot be delivered.
 *
 * This mirrors `resolveSendChannel` for the `inbox` surface
 * (lib/whatsapp/channels.ts):
 *
 *   1. a person's pin on the chat (`send_channel_id`, migration 061);
 *   2. the chat's own number (`channel_id`). Inbound moves it to the
 *      number the customer last wrote to, which is the number the
 *      server's follow-the-customer rule picks;
 *   3. the account's fallback, like `primaryChannel`: the default
 *      number, then a Whapi one, then the oldest.
 *
 * Step 3 is a guess. The server's real answer there also weighs the
 * inbox route and the sender's allocations, which the browser does not
 * load for this. It only matters for a chat that has never had a
 * number. A pin or chat number that no longer exists falls through,
 * as it does server-side.
 */
export function predictSendingNumber<
  T extends { id: string; provider: string; is_primary: boolean },
>(
  numbers: readonly T[],
  conversation: {
    channel_id?: string | null;
    send_channel_id?: string | null;
  }
): T | null {
  if (numbers.length === 0) return null;
  const byId = (id: string | null | undefined) =>
    id ? numbers.find((n) => n.id === id) : undefined;
  return (
    byId(conversation.send_channel_id) ??
    byId(conversation.channel_id) ??
    numbers.find((n) => n.is_primary) ??
    numbers.find((n) => n.provider === 'whapi') ??
    numbers[0]
  );
}
