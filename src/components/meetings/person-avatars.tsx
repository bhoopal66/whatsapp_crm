'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { avatarTint } from '@/lib/chat/view';
import { cn } from '@/lib/utils';

export interface AvatarPerson {
  userId: string;
  name: string;
  avatarUrl: string | null;
}

/** Up to two initials: "Sara Ahmed" → "SA". */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return (
    letters
      .map((w) => [...w][0] ?? '')
      .join('')
      .toUpperCase() || '?'
  );
}

export function PersonAvatar({
  person,
  size = 'default',
  className,
}: {
  person: AvatarPerson;
  size?: 'default' | 'sm' | 'lg';
  className?: string;
}) {
  return (
    <Avatar size={size} className={className}>
      {person.avatarUrl && <AvatarImage src={person.avatarUrl} alt="" />}
      {/* The person's team chat tint, so a colleague looks the same in
          both places. */}
      <AvatarFallback className={avatarTint(person.userId)}>
        {initials(person.name)}
      </AvatarFallback>
    </Avatar>
  );
}

/** Overlapping avatars, `max` of them then "+N"; names in the tooltip. */
export function AvatarStack({
  people,
  max = 4,
  moreLabel,
}: {
  people: AvatarPerson[];
  max?: number;
  /** "+3": the hidden people, worded by the caller. */
  moreLabel: (count: number) => string;
}) {
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  const hidden = people.length - shown.length;
  return (
    <div
      className="flex items-center -space-x-2"
      title={people.map((p) => p.name).join(', ')}
    >
      {shown.map((p) => (
        <PersonAvatar
          key={p.userId}
          person={p}
          size="sm"
          className="ring-card ring-2"
        />
      ))}
      {hidden > 0 && (
        <span
          className={cn(
            'bg-muted text-muted-foreground ring-card relative flex size-6 items-center justify-center rounded-full text-[10px] font-medium ring-2'
          )}
        >
          {moreLabel(hidden)}
        </span>
      )}
    </div>
  );
}
