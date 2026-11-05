/**
 * Who wrote a bubble, at a glance: every user and every phone number in a
 * group chat (WhatsApp groups, submission groups, a case's conversation)
 * wears its own colour on the name line and on the bubble's edge.
 *
 * Dependency-free on purpose, so client components and tests can use it.
 * Every class is a complete literal: Tailwind finds classes by scanning
 * source text, so a hue spliced in at runtime is never generated. Each
 * string carries its own `dark:` pair.
 */

/** The class strings a sender wears. */
export interface SenderColor {
  /** The name line on an incoming bubble. */
  text: string;
  /** The name line on an outgoing bubble. */
  textOut: string;
  /** The bubble's edge: a border colour, so give the bubble one side's width. */
  stripe: string;
}

/**
 * Ten hues, in wheel order. Any two senders can draw any two of them, so
 * the worst pair is what counts: this is the set of ten that sits furthest
 * apart, and twelve only brought near-twins (teal beside emerald).
 *
 * The green outgoing bubble in dark mode is the hard one: it needs shades
 * so pale that they barely differ, which is why incoming names don't share
 * them, and why the stripe is the stronger signal. Don't drop it for the
 * name alone. sender-colors.test.ts measures the contrast and the distances
 * from Tailwind's theme and the bubble tokens.
 */
export const SENDER_COLORS: readonly SenderColor[] = [
  {
    text: 'text-red-700 dark:text-red-400',
    textOut: 'text-red-700 dark:text-red-200',
    stripe: 'border-red-600 dark:border-red-400',
  },
  {
    text: 'text-orange-700 dark:text-orange-400',
    textOut: 'text-orange-700 dark:text-orange-300',
    stripe: 'border-orange-600 dark:border-orange-400',
  },
  {
    text: 'text-yellow-800 dark:text-yellow-400',
    textOut: 'text-yellow-800 dark:text-yellow-400',
    stripe: 'border-yellow-700 dark:border-yellow-400',
  },
  {
    text: 'text-lime-800 dark:text-lime-400',
    textOut: 'text-lime-800 dark:text-lime-400',
    stripe: 'border-lime-600 dark:border-lime-400',
  },
  {
    text: 'text-emerald-700 dark:text-emerald-400',
    textOut: 'text-emerald-700 dark:text-emerald-300',
    stripe: 'border-emerald-600 dark:border-emerald-400',
  },
  {
    text: 'text-cyan-700 dark:text-cyan-400',
    textOut: 'text-cyan-700 dark:text-cyan-300',
    stripe: 'border-cyan-600 dark:border-cyan-400',
  },
  {
    text: 'text-blue-600 dark:text-blue-400',
    textOut: 'text-blue-600 dark:text-blue-200',
    stripe: 'border-blue-600 dark:border-blue-400',
  },
  {
    text: 'text-violet-600 dark:text-violet-400',
    textOut: 'text-violet-600 dark:text-violet-200',
    stripe: 'border-violet-600 dark:border-violet-400',
  },
  {
    text: 'text-fuchsia-700 dark:text-fuchsia-400',
    textOut: 'text-fuchsia-700 dark:text-fuchsia-200',
    stripe: 'border-fuchsia-600 dark:border-fuchsia-400',
  },
  {
    text: 'text-pink-700 dark:text-pink-400',
    textOut: 'text-pink-700 dark:text-pink-200',
    stripe: 'border-pink-600 dark:border-pink-400',
  },
];

/**
 * How far round the wheel a sender moves on a clash: across it, so two
 * senders who clash don't end up on neighbouring hues. It must share no
 * factor with the palette's length, or the walk misses colours and two
 * senders share one with others free.
 */
const CLASH_STEP = 3;

/** No person to tell apart: an automatic message, a sender nothing names. */
export const NEUTRAL_SENDER_COLOR: SenderColor = {
  text: 'text-slate-600 dark:text-slate-200',
  textOut: 'text-slate-600 dark:text-slate-200',
  stripe: 'border-slate-500 dark:border-slate-400',
};

/** The sender columns the two group message tables have in common. */
export interface SenderIdentity {
  sender_user_id?: string | null;
  sender_wa_id?: string | null;
  sender_name?: string | null;
  system_kind?: string | null;
}

/**
 * One key per sender: the user who sent it from the CRM, else the number
 * (digits or `<digits>@lid`, already normalised when it was stored), else
 * the name, for a row that has only that. An automatic message and a row
 * nothing identifies have none.
 */
export function senderKey(m: SenderIdentity): string | null {
  if (m.system_kind) return null;
  if (m.sender_user_id) return `user:${m.sender_user_id}`;
  if (m.sender_wa_id) return `wa:${m.sender_wa_id}`;
  const name = m.sender_name?.trim().toLowerCase();
  return name ? `name:${name}` : null;
}

/** The colour a sender gets when nobody in the chat clashes with them. */
function preferredSlot(key: string): number {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % SENDER_COLORS.length;
}

/**
 * Colours for the senders of one chat.
 *
 * A hash alone would give two people the same colour in nearly one
 * three-person chat in three. So each sender has a colour of their own,
 * the same in every chat, and a clash is settled by the order of the keys.
 * Never the order they wrote in: that shifts as the loaded messages slide,
 * and it would repaint the same people from one day to the next. The same
 * senders always get the same colours. Someone coming into or dropping out
 * of the loaded messages moves only the senders they clash with and, rarely,
 * whoever those displace in turn. A chat with more senders than colours
 * starts round the palette again.
 */
export function assignSenderColors(
  keys: Iterable<string | null>
): Map<string, SenderColor> {
  const senders = [...new Set(keys)]
    .filter((key): key is string => key !== null)
    .sort();
  const colors = new Map<string, SenderColor>();
  let taken = new Set<number>();
  for (const key of senders) {
    if (taken.size === SENDER_COLORS.length) taken = new Set();
    let slot = preferredSlot(key);
    for (let i = 0; i < SENDER_COLORS.length && taken.has(slot); i++)
      slot = (slot + CLASH_STEP) % SENDER_COLORS.length;
    taken.add(slot);
    colors.set(key, SENDER_COLORS[slot]);
  }
  return colors;
}

/** Looks up each message's colour among all the messages of its chat. */
export function senderColors(
  messages: readonly SenderIdentity[]
): (m: SenderIdentity) => SenderColor {
  const colors = assignSenderColors(messages.map(senderKey));
  return (m) => {
    const key = senderKey(m);
    return (key && colors.get(key)) || NEUTRAL_SENDER_COLOR;
  };
}
