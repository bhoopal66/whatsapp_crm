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
 * Twelve hues in wheel order, so a colour's neighbours are the two most
 * like it (emerald and teal are the closest pair). `assignSenderColors`
 * relies on that order.
 *
 * Names are measured at 4.5:1 or better on their bubbles (`--wa-bubble-in`
 * / `--wa-bubble-out`, both modes). The green outgoing bubble in dark mode
 * is the hard one: it needs shades so pale that they barely differ, which
 * is why incoming names don't share them, and why `stripe` is the stronger
 * signal. Don't drop it for the name alone.
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
    text: 'text-amber-700 dark:text-amber-400',
    textOut: 'text-amber-700 dark:text-amber-400',
    stripe: 'border-amber-600 dark:border-amber-400',
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
    text: 'text-teal-700 dark:text-teal-400',
    textOut: 'text-teal-700 dark:text-teal-300',
    stripe: 'border-teal-600 dark:border-teal-400',
  },
  {
    text: 'text-cyan-700 dark:text-cyan-400',
    textOut: 'text-cyan-700 dark:text-cyan-300',
    stripe: 'border-cyan-600 dark:border-cyan-400',
  },
  {
    text: 'text-sky-700 dark:text-sky-400',
    textOut: 'text-sky-700 dark:text-sky-300',
    stripe: 'border-sky-600 dark:border-sky-400',
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

/** No person to tell apart: an automatic message, a sender nothing names. */
export const NEUTRAL_SENDER_COLOR: SenderColor = {
  text: 'text-slate-600 dark:text-slate-200',
  textOut: 'text-slate-600 dark:text-slate-200',
  stripe: 'border-slate-400 dark:border-slate-500',
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

/** The colour a sender gets when nothing else in the chat is in the way. */
function preferredSlot(key: string): number {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % SENDER_COLORS.length;
}

/**
 * The first slot from `preferred` round the wheel with free neighbours as
 * well, else the first free one. `taken` must not be full.
 */
function pickSlot(preferred: number, taken: ReadonlySet<number>): number {
  const n = SENDER_COLORS.length;
  const isTaken = (slot: number) => taken.has((slot + n) % n);
  const wheel = Array.from({ length: n }, (_, i) => (preferred + i) % n);
  const clear = wheel.find(
    (s) => !isTaken(s) && !isTaken(s - 1) && !isTaken(s + 1)
  );
  return clear ?? wheel.find((s) => !isTaken(s)) ?? preferred;
}

/**
 * Colours for one chat's senders, given in the order they first wrote.
 *
 * A hash alone would give two people the same colour in about one
 * three-person chat in four; numbering them in order would repaint everyone
 * as the loaded messages slide. So each sender has a colour of their own,
 * the same in every chat, and gives way only to someone who wrote before
 * them. That makes colours differ for as long as the palette lasts, and at
 * least the first four senders never sit on neighbouring hues. A newcomer
 * never moves anyone who already wrote; only loading older messages can,
 * and only someone who clashes with the sender that reveals. A chat with
 * more senders than colours starts round the palette again, evenly.
 */
export function assignSenderColors(
  keys: Iterable<string | null>
): Map<string, SenderColor> {
  const colors = new Map<string, SenderColor>();
  let taken = new Set<number>();
  for (const key of keys) {
    if (key === null || colors.has(key)) continue;
    if (taken.size === SENDER_COLORS.length) taken = new Set();
    const slot = pickSlot(preferredSlot(key), taken);
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
