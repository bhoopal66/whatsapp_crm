'use client';

// ============================================================
// A chat's tags on an inbox list row, sized for the narrow desktop
// column: the main tag as a compact pill (its name, truncating), and
// the sub-tag (usually a bank) as a second short pill with a compact
// label ("ADCB", "RAKBANK"). The full "main · sub" name is in the
// tooltip and the aria-label, so a cut name never hides which tag it
// is. The name is always written out: colour is never the only cue.
//
// A <span> trigger, not a button: the whole row is a <button>.
// ============================================================

import {
  chatTagColor,
  chatTagMainStyle,
  chatTagSubStyle,
} from '@/lib/chat-tags/style';
import { compactSubTagLabel } from '@/lib/inbox/row-layout';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

type TagLike = { name: string; color: string | null | undefined };

const PILL =
  'inline-flex h-5 min-w-0 items-center gap-1 rounded-full border px-1.5 text-xs leading-none';

function Dot({ color }: { color: string | null | undefined }) {
  return (
    <span
      aria-hidden="true"
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: chatTagColor(color) }}
    />
  );
}

export function RowChatTags({
  main,
  sub,
  label,
  className,
}: {
  main: TagLike;
  sub: TagLike | null;
  /** The full "main · sub" name (`chatTagLabel`). */
  label: string;
  className?: string;
}) {
  const mainStyle = chatTagMainStyle(main.color);
  const subStyle = sub ? chatTagSubStyle(main.color, sub.color) : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            className={cn(
              'inline-flex max-w-full min-w-0 shrink items-center gap-1',
              className
            )}
          />
        }
      >
        <span
          aria-hidden="true"
          className={cn(PILL, 'max-w-[9rem]')}
          style={{
            backgroundColor: mainStyle.backgroundColor,
            borderColor: mainStyle.borderColor,
            color: mainStyle.color,
          }}
        >
          <Dot color={main.color} />
          <span className="truncate font-semibold">{main.name}</span>
        </span>
        {sub && subStyle && (
          <span
            aria-hidden="true"
            className={cn(PILL, 'text-wa-text shrink-0 font-medium')}
            style={{
              backgroundColor: subStyle.backgroundColor,
              borderColor: subStyle.borderColor,
            }}
          >
            <Dot color={sub.color} />
            {compactSubTagLabel(sub.name)}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
