// Avatars, ordering and small display rules for the room.

export const AVATAR_COLORS = [
  'bg-sky-600',
  'bg-emerald-600',
  'bg-violet-600',
  'bg-amber-600',
  'bg-rose-600',
  'bg-teal-600',
  'bg-indigo-600',
  'bg-fuchsia-600',
] as const;

/** Up to two letters: first and last word. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = Array.from(parts[0] ?? '')[0] ?? '';
  const last = parts.length > 1 ? (Array.from(parts.at(-1)!)[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** The same colour for one person on every screen (FNV-1a of the id). */
export function avatarColor(userId: string): (typeof AVATAR_COLORS)[number] {
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export interface PersonForOrder {
  id: string;
  isSelf: boolean;
  name: string;
  handRaisedAt: string | null;
}

/** Raised hands first (earliest first), then ourselves, then by name. */
export function orderPeople<T extends PersonForOrder>(
  people: readonly T[]
): T[] {
  return [...people].sort((a, b) => {
    if (a.handRaisedAt && b.handRaisedAt)
      return a.handRaisedAt.localeCompare(b.handRaisedAt);
    if (a.handRaisedAt) return -1;
    if (b.handRaisedAt) return 1;
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** `hand_raised_at` of a participant row, once the engine selects it (107). */
export function handRaisedAtOf(row: object): string | null {
  const v = (row as { hand_raised_at?: unknown }).hand_raised_at;
  return typeof v === 'string' && v ? v : null;
}

/** Signal bars for a quality reading; 0 draws nothing. */
export function qualityBars(q: 'good' | 'fair' | 'poor' | 'unknown'): number {
  return q === 'good' ? 3 : q === 'fair' ? 2 : q === 'poor' ? 1 : 0;
}

/** Live timer: m:ss under an hour, else h:mm:ss. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Horizontal start of a floating reaction, 10–85 % of the stage. */
export function reactionOffset(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return 10 + (h % 76);
}
