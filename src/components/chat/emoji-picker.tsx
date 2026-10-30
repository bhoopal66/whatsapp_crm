'use client';

import { useRef, useState, type ReactElement, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { Clock, Search } from 'lucide-react';

import {
  EMOJI_CATEGORIES,
  categoryIcon,
  emojiEntry,
  emojiIn,
  gridMove,
  parseRecents,
  pushRecent,
  searchEmoji,
  type EmojiCategory,
  type GridKey,
} from '@/lib/chat/emoji-data';
import { cn } from '@/lib/utils';

const RECENTS_KEY = 'chat.emojiRecents';
const COLS = 8;
const GRID_KEYS: readonly string[] = [
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
];

type Tab = 'recent' | EmojiCategory;

function readRecents(): string[] {
  try {
    return parseRecents(window.localStorage.getItem(RECENTS_KEY));
  } catch {
    return [];
  }
}

function saveRecents(list: string[]) {
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  } catch {
    // Storage blocked: the Recent row just doesn't remember.
  }
}

const POPUP_CLASS =
  'z-50 flex w-[19rem] max-w-(--available-width) origin-(--transform-origin) flex-col gap-2 rounded-lg bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95';

export interface EmojiPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen emoji; the picker then closes. */
  onPick: (emoji: string) => void;
  /** A button that toggles the picker (becomes the popover trigger). */
  trigger?: ReactElement;
  /** Position against this instead of the trigger. */
  anchor?: RefObject<Element | null>;
  /** Where focus goes when the picker closes (default: the trigger). */
  finalFocus?: PopoverPrimitive.Popup.Props['finalFocus'];
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
}

/**
 * The team-chat emoji picker: search, a Recent row (this browser only)
 * and seven categories, in a grid you can walk with the arrow keys.
 */
export function EmojiPicker(p: EmojiPickerProps) {
  const t = useTranslations('Chat.emoji');
  const search = useRef<HTMLInputElement>(null);
  return (
    <PopoverPrimitive.Root open={p.open} onOpenChange={p.onOpenChange}>
      {p.trigger && <PopoverPrimitive.Trigger render={p.trigger} />}
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={p.anchor}
          side={p.side ?? 'top'}
          align={p.align ?? 'end'}
          sideOffset={6}
          collisionPadding={8}
          className="isolate z-50"
        >
          <PopoverPrimitive.Popup
            aria-label={t('picker')}
            initialFocus={search}
            finalFocus={p.finalFocus}
            className={POPUP_CLASS}
          >
            {/* Mounted per opening: search and tab start fresh. */}
            {p.open && (
              <PickerBody
                searchRef={search}
                onPick={(emoji) => {
                  p.onPick(emoji);
                  p.onOpenChange(false);
                }}
              />
            )}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function PickerBody({
  onPick,
  searchRef,
}: {
  onPick: (emoji: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  const t = useTranslations('Chat.emoji');
  const [recents, setRecents] = useState(readRecents);
  const [tab, setTab] = useState<Tab>(() =>
    recents.length > 0 ? 'recent' : 'smileys'
  );
  const [query, setQuery] = useState('');
  const [active, setActive] = useState({ view: '', i: 0 });
  const cells = useRef<(HTMLButtonElement | null)[]>([]);

  const searching = query.trim() !== '';
  const view = searching ? `q:${query}` : tab;
  const list: string[] = searching
    ? searchEmoji(query).map((e) => e.emoji)
    : tab === 'recent'
      ? recents
      : emojiIn(tab).map((e) => e.emoji);
  const activeIndex =
    active.view === view ? Math.min(active.i, list.length - 1) : 0;
  const label = searching
    ? t('search')
    : t(tab === 'recent' ? 'recent' : `categories.${tab}`);

  const pick = (emoji: string) => {
    const next = pushRecent(recents, emoji);
    setRecents(next);
    saveRecents(next);
    onPick(emoji);
  };

  const focusCell = (i: number) => {
    setActive({ view, i });
    cells.current[i]?.focus();
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    if (!GRID_KEYS.includes(e.key)) return;
    e.preventDefault();
    focusCell(gridMove(activeIndex, e.key as GridKey, list.length, COLS));
  };

  return (
    <>
      <div className="relative">
        <Search
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2"
          aria-hidden
        />
        <input
          ref={searchRef}
          type="search"
          value={query}
          aria-label={t('search')}
          placeholder={t('search')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && list.length > 0) {
              e.preventDefault();
              focusCell(activeIndex);
            } else if (
              e.key === 'Enter' &&
              !e.nativeEvent.isComposing &&
              searching &&
              list.length > 0
            ) {
              e.preventDefault();
              pick(list[0]);
            }
          }}
          className="border-input bg-card dark:bg-input/30 placeholder:text-muted-foreground focus-visible:ring-ring/40 h-8 w-full rounded-md border pr-2 pl-8 text-sm outline-none focus-visible:ring-2"
        />
      </div>
      {!searching && (
        <div role="tablist" aria-label={t('picker')} className="flex gap-0.5">
          {(['recent', ...EMOJI_CATEGORIES] as const).map((c) => {
            const name = t(c === 'recent' ? 'recent' : `categories.${c}`);
            return (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={tab === c}
                aria-label={name}
                title={name}
                onClick={() => setTab(c)}
                className={cn(
                  'hover:bg-muted flex size-8 flex-1 items-center justify-center rounded-md text-base',
                  tab === c && 'bg-muted'
                )}
              >
                {c === 'recent' ? (
                  <Clock className="size-4" aria-hidden />
                ) : (
                  categoryIcon(c)
                )}
              </button>
            );
          })}
        </div>
      )}
      <div
        role="group"
        aria-label={label}
        onKeyDown={onGridKey}
        className="grid h-56 auto-rows-min grid-cols-8 gap-0.5 overflow-y-auto"
      >
        {list.length === 0 ? (
          <p className="text-muted-foreground col-span-8 px-1 py-2 text-sm">
            {t('noResults')}
          </p>
        ) : (
          list.map((emoji, i) => {
            const name = emojiEntry(emoji)?.name ?? emoji;
            return (
              <button
                key={emoji}
                ref={(el) => {
                  cells.current[i] = el;
                }}
                type="button"
                tabIndex={i === activeIndex ? 0 : -1}
                aria-label={name}
                title={name}
                onClick={() => pick(emoji)}
                onFocus={() => setActive({ view, i })}
                className="hover:bg-muted focus-visible:ring-ring/40 flex size-8 items-center justify-center rounded-md text-xl outline-none focus-visible:ring-2"
              >
                {emoji}
              </button>
            );
          })
        )}
      </div>
    </>
  );
}
