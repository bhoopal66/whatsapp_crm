// ============================================================
// Typed answers to buttons and lists — the pure half.
//
// A run waiting on a `send_buttons` / `send_list` node advances on a
// tap. Customers often type instead: the option's label, or its number
// (an OpenWA number has no buttons at all and sends the options as a
// numbered text menu, see `renderOptionsText` in
// lib/whatsapp/openwa-api.ts). This file answers the two cheap cases
// without Jev:
//
//   * the text IS one option's label, after normalising case, Arabic
//     diacritics and tatweel, emoji, whitespace and surrounding
//     punctuation → that option (`label`);
//   * the text is an ordinal within range ("2", "2.", "#2", "option 2",
//     "٢") → the option at that position, counted 1..N across a list's
//     sections in order, the same numbering OpenWA's menu prints
//     (`number`).
//
// Anything else is null, and the caller may ask Jev
// (typed-reply-judge.ts). Ambiguity is null, never a guess.
// ============================================================

import type { SendButtonsNodeConfig, SendListNodeConfig } from './types';

export interface ReplyOption {
  reply_id: string;
  title: string;
  description?: string;
  next_node_key: string;
}

export interface TypedReplyMatch {
  /** 0-based position in `replyOptionsForNode`'s order. */
  index: number;
  option: ReplyOption;
  by: 'label' | 'number';
}

/**
 * The options a node offers, in display order (a list's rows flattened
 * across its sections), or null for a node that offers none.
 */
export function replyOptionsForNode(node: {
  node_type: string;
  config: Record<string, unknown>;
}): ReplyOption[] | null {
  if (node.node_type === 'send_buttons') {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    return (cfg.buttons ?? []).map((b) => ({
      reply_id: b.reply_id,
      title: b.title ?? '',
      next_node_key: b.next_node_key,
    }));
  }
  if (node.node_type === 'send_list') {
    const cfg = node.config as unknown as SendListNodeConfig;
    return (cfg.sections ?? []).flatMap((s) =>
      (s.rows ?? []).map((r) => ({
        reply_id: r.reply_id,
        title: r.title ?? '',
        description: r.description,
        next_node_key: r.next_node_key,
      }))
    );
  }
  return null;
}

// Arabic harakat, Quranic marks, superscript alef, and tatweel (U+0640).
const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭـ]/g;
// Pictographs, skin tones, flags, ZWJ, variation selectors, the keycap
// combiner (so "2️⃣" reads as "2") and emoji tag characters.
const EMOJI =
  /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}‍︎️⃣\u{E0020}-\u{E007F}]/gu;
const EDGE = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;

/** Arabic-Indic (U+0660..) and Extended Arabic-Indic (U+06F0..) to ASCII. */
function asciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
}

export function normaliseReplyText(s: string): string {
  return asciiDigits(
    s
      .normalize('NFKC')
      .toLowerCase()
      .replace(ARABIC_MARKS, '')
      .replace(EMOJI, ' ')
  )
    .replace(/\s+/g, ' ')
    .replace(EDGE, '')
    .trim();
}

/** The comparison key: normalised, or for an emoji-only label the raw text. */
function labelKey(s: string): string {
  return normaliseReplyText(s) || s.normalize('NFKC').trim();
}

const ORDINAL =
  /^(?:(?:option|opt|choice|number|num|no|رقم|خيار|الخيار)\.?\s*)?#?\s*(\d{1,2})$/u;

/** The 1-based ordinal the text names, or null. Range is the caller's. */
export function parseOrdinal(text: string): number | null {
  const m = ORDINAL.exec(normaliseReplyText(text));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 ? n : null;
}

export function matchTypedReply(
  options: ReplyOption[],
  text: string
): TypedReplyMatch | null {
  if (options.length === 0) return null;
  const key = labelKey(text);
  if (!key) return null;

  // 1. Label. Titles first, then list-row descriptions; a text that
  //    names two different options is ambiguous and matches nothing.
  const hits = new Set<number>();
  options.forEach((o, i) => {
    if (labelKey(o.title) === key) hits.add(i);
  });
  if (hits.size === 0) {
    options.forEach((o, i) => {
      if (o.description && labelKey(o.description) === key) hits.add(i);
    });
  }
  if (hits.size === 1) {
    const index = [...hits][0]!;
    return { index, option: options[index]!, by: 'label' };
  }
  if (hits.size > 1) return null;

  // 2. Ordinal. Skipped when an option's own label reads as a number
  //    ("10", "#3"): "2" could then mean the second option or a value,
  //    and that is Jev's call, not ours.
  if (options.some((o) => parseOrdinal(o.title) !== null)) return null;
  const n = parseOrdinal(text);
  if (n === null || n > options.length) return null;
  return { index: n - 1, option: options[n - 1]!, by: 'number' };
}
