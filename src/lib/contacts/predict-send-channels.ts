// Which number the contact screens' two send actions will go out on,
// predicted for the caption under the buttons and the message dialog.
// The send route decides; this only says what it will most likely do.

import {
  predictNumber,
  type AccountNumber,
} from '@/hooks/use-whatsapp-numbers';

import type { ContactThread } from './contact-thread';

export interface SendChannelPrediction {
  /** A plain message: sent with `provider: 'whapi'`. */
  messageChannel: AccountNumber | null;
  /** An approved template: sent with `provider: 'meta'`. */
  templateChannel: AccountNumber | null;
}

/**
 * Mirrors resolveSendChannel: a person's pin on the chat wins when it
 * is the kind of number the button asks for, or when that kind is not
 * connected at all; otherwise the kind wins, preferring the thread's
 * own number, then one this user is allocated to. With neither, the
 * account's primary number (else the first).
 */
export function predictSendChannels(
  list: readonly AccountNumber[],
  thread: Pick<ContactThread, 'pin' | 'home'>,
  myNumberIds: readonly string[] | null
): SendChannelPrediction {
  const numbers = [...list];
  const fallback = numbers.find((c) => c.is_primary) ?? numbers[0] ?? null;
  const pinned = thread.pin
    ? numbers.find((c) => c.id === thread.pin)
    : undefined;
  const pick = (provider: 'whapi' | 'meta') =>
    (pinned &&
    (pinned.provider === provider ||
      !numbers.some((c) => c.provider === provider))
      ? pinned
      : predictNumber(numbers, provider, [
          thread.home,
          ...(myNumberIds ?? []),
        ])) ?? fallback;
  return {
    messageChannel: pick('whapi'),
    templateChannel: pick('meta'),
  };
}
