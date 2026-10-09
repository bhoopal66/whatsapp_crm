// ============================================================
// A chat's tags drawn as one pill: the main tag ("Interested
// customer") on a tint of its colour, and — when the chat has one —
// its sub-tag ("ADCB") joined on the right, fainter and in its own
// colour. One pill says "this tag, and this detail of it"; two loose
// chips read as two unrelated tags.
//
// Read-only. The thread header builds the same two halves out of menu
// triggers (thread-tag-bar.tsx) from the classes exported here.
// ============================================================

import {
  chatTagColor,
  chatTagMainStyle,
  chatTagSubStyle,
} from '@/lib/chat-tags/style';
import { cn } from '@/lib/utils';

export type ChatTagPillSize = 'sm' | 'md';

/** One half of the pill: height, padding and type size. */
export const PILL_HALF: Record<ChatTagPillSize, string> = {
  sm: 'h-[18px] gap-1 px-1.5 text-[10.5px]',
  md: 'h-7 gap-1.5 px-2.5 text-xs',
};

export const PILL_DOT: Record<ChatTagPillSize, string> = {
  sm: 'h-1.5 w-1.5',
  md: 'h-2 w-2',
};

/** The main tag's name: the strong half. */
export const PILL_MAIN_TEXT = 'truncate font-semibold';
/** The sub-tag's name: the detail. */
export const PILL_SUB_TEXT = 'text-wa-text truncate font-medium';

export function PillDot({
  color,
  size,
}: {
  color: string | null | undefined;
  size: ChatTagPillSize;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn('shrink-0 rounded-full', PILL_DOT[size])}
      style={{ backgroundColor: chatTagColor(color) }}
    />
  );
}

export function ChatTagPill({
  main,
  sub,
  size,
  title,
  className,
}: {
  main: { name: string; color: string | null | undefined };
  sub?: { name: string; color: string | null | undefined } | null;
  size: ChatTagPillSize;
  title?: string;
  className?: string;
}) {
  const mainStyle = chatTagMainStyle(main.color);
  return (
    <span
      title={title}
      className={cn(
        'inline-flex max-w-full min-w-0 items-stretch overflow-hidden rounded-full border leading-none',
        className
      )}
      style={{ borderColor: mainStyle.borderColor }}
    >
      <span
        className={cn('flex min-w-0 items-center', PILL_HALF[size])}
        style={{
          backgroundColor: mainStyle.backgroundColor,
          color: mainStyle.color,
        }}
      >
        <PillDot color={main.color} size={size} />
        <span className={PILL_MAIN_TEXT}>{main.name}</span>
      </span>
      {sub && (
        <span
          // A sub-tag is a short detail ("ADCB"): it keeps its room
          // and a long main tag truncates instead.
          className={cn(
            'flex max-w-[50%] min-w-0 shrink-0 items-center border-l',
            PILL_HALF[size]
          )}
          style={chatTagSubStyle(main.color, sub.color)}
        >
          <PillDot color={sub.color} size={size} />
          <span className={PILL_SUB_TEXT}>{sub.name}</span>
        </span>
      )}
    </span>
  );
}
