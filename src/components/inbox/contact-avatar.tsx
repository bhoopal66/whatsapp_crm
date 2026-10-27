'use client';

import { UserRound } from 'lucide-react';
import { avatarTint } from '@/lib/chat/view';
import { cn } from '@/lib/utils';
import type { Contact } from '@/types';

/**
 * A contact's round avatar, the same everywhere in the inbox: the photo
 * when the gateway gave us one, otherwise the initial on a pastel tint
 * keyed to the name (the same tint everywhere, so a customer is easy to
 * spot again down the list) — or a person glyph on WhatsApp's neutral
 * avatar grey when the name is really a number ("+9715…" would otherwise
 * put a lone "+" in the circle).
 * `size` is the diameter in pixels.
 */
export function ContactAvatar({
  contact,
  name,
  size,
  className,
}: {
  contact: Pick<Contact, 'avatar_url'> | null | undefined;
  /** What the row calls this contact; its first letter is the fallback. */
  name: string;
  size: number;
  className?: string;
}) {
  const style = { width: size, height: size };
  if (contact?.avatar_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={contact.avatar_url}
        alt={name}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        style={style}
        className={cn('shrink-0 rounded-full object-cover', className)}
      />
    );
  }
  const initial = name.trim().charAt(0).toUpperCase();
  const isLetter = /\p{L}/u.test(initial);
  return (
    <div
      aria-hidden="true"
      style={{ ...style, fontSize: Math.round(size * 0.4) }}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-medium select-none',
        isLetter ? avatarTint(name.trim()) : 'bg-wa-avatar text-wa-avatar-fg',
        className
      )}
    >
      {isLetter ? (
        initial
      ) : (
        <UserRound style={{ width: size * 0.55, height: size * 0.55 }} />
      )}
    </div>
  );
}
