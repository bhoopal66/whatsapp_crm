// ============================================================
// The "Tagged automatically" note (migration 147, docs/jev-insights.md).
//
// autoTagFromInsights leaves a `conversation_events` row of kind
// `chat_tag_auto`: `to_label` is the tag's name as it read at tagging
// time ("Interested · ADCB"), so the note survives a later rename or
// delete, and `details` carries `{ chat_tag_id, chat_sub_tag_id, p }`.
// Pure: the writer and the timeline both use it, and the timeline is a
// client component, so nothing server-side may be imported here.
// ============================================================

/** `details` of a chat_tag_auto note. */
export interface AutoTagNote {
  chat_tag_id: string;
  chat_sub_tag_id: string | null;
  p: number;
}

/** "Main · Sub" (or the main name alone); null when the main is unknown. */
export function autoTagLabel(
  mainName: string | null | undefined,
  subName: string | null | undefined
): string | null {
  const main = mainName?.trim();
  if (!main) return null;
  const sub = subName?.trim();
  return sub ? `${main} · ${sub}` : main;
}

/**
 * Jev's probability from a note's details as a whole percentage, or
 * null when it is missing or not a probability (older or hand-written
 * rows): the note then reads without a figure.
 */
export function autoTagPercent(details: unknown): number | null {
  if (typeof details !== 'object' || details === null) return null;
  const p = (details as { p?: unknown }).p;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1)
    return null;
  return Math.round(p * 100);
}

/** The kinds the timeline draws; a row of any other kind is never shown. */
export const RENDERED_EVENT_KINDS = [
  'channel_switched',
  'chat_tag_auto',
] as const;

export function isRenderedEventKind(
  kind: unknown
): kind is (typeof RENDERED_EVENT_KINDS)[number] {
  return (RENDERED_EVENT_KINDS as readonly unknown[]).includes(kind);
}
