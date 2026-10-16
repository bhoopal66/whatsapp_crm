'use client';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { chatTagChipStyle, chatTagColor } from '@/lib/chat-tags/style';

/** A contact's chat tag as the inbox list draws it: dot + label on a
 *  tint of the tag colour, text in the theme's foreground. */
export function ChatTagChip({
  chip,
}: {
  chip: { label: string; color: string } | null;
}) {
  if (!chip) return <span className="text-muted-foreground text-xs">-</span>;
  return (
    <span
      title={chip.label}
      style={chatTagChipStyle(chip.color)}
      className="text-foreground inline-flex max-w-[14rem] min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium"
    >
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: chatTagColor(chip.color) }}
      />
      <span className="truncate">{chip.label}</span>
    </span>
  );
}

/** Set when the customer asked not to be messaged (migration 076).
 *  Focusable, and named by the full hint (date included), so a keyboard
 *  or screen-reader user gets what the tooltip says on hover. */
export function OptedOutBadge({
  label,
  hint,
}: {
  label: string;
  hint: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            tabIndex={0}
            aria-label={hint}
            className="border-destructive/40 bg-destructive/10 text-destructive focus-visible:ring-ring/50 inline-flex shrink-0 items-center rounded-full border px-1.5 text-[10px] leading-4 font-medium outline-none focus-visible:ring-2"
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}
