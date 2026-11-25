'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CornerUpLeft, Copy, Forward, SmilePlus } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { Message } from '@/types';
import { isForwardable } from '@/lib/whatsapp/forward';
import { useTranslations } from 'next-intl';
import { useContextMenuItems } from '@/components/context-menu/registry';
import { isTouchContextMenu } from '@/lib/context-menu/resolve';
import {
  createOpenSlot,
  HOLD_CONTROL_SELECTOR,
  leftPress,
  LONG_PRESS_MS,
  startsLongPress,
  swallowsClick,
} from '@/lib/inbox/message-toolbar';

// WhatsApp's own quick-reaction bar starts with these six. Picking the same
// set keeps the affordance familiar without pulling in a 300KB emoji library.
const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

// Every row of every thread shares it: one touch toolbar at a time.
const openToolbar = createOpenSlot();

interface MessageActionsProps {
  message: Message;
  onReply: () => void;
  onReact: (emoji: string) => void;
  /** Omitted → no Forward button (e.g. the caller can't send). */
  onForward?: () => void;
  /** Extra classes for the row, e.g. the gap above it. */
  className?: string;
  children: ReactNode;
}

/**
 * Hover/long-press toolbar wrapper around a `<MessageBubble>`. The bubble
 * itself stays a pure presenter — this component owns the action surface so
 * the bubble's render path is unaffected when the toolbar isn't visible.
 */
export function MessageActions({
  message,
  onReply,
  onReact,
  onForward,
  className,
  children,
}: MessageActionsProps) {
  const t = useTranslations('Inbox.actions');

  // Touch devices have no hover. A long press pins the toolbar open until
  // the user touches something else: timed here, because iOS Safari may
  // never fire the `contextmenu` Android sends for it (that one opens the
  // toolbar too, with the native menu suppressed). A mouse right-click is
  // left alone, so the app-wide menu opens with this message's actions
  // (registered below).
  const [touchOpen, setTouchOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const lastPointerTypeRef = useRef<string | null>(null);
  const pressRef = useRef<{ x: number; y: number; stop: () => void } | null>(
    null
  );
  // About the latest press on the row, for the click that ends it.
  const pressedOnRef = useRef<'toolbar' | 'message' | null>(null);
  const afterLongPressRef = useRef(false);

  const isAgent =
    message.sender_type === 'agent' || message.sender_type === 'bot';

  const close = useCallback(() => {
    setTouchOpen(false);
    setPickerOpen(false);
  }, []);

  const cancelPress = () => {
    pressRef.current?.stop();
    pressRef.current = null;
  };

  const openByTouch = () => {
    cancelPress();
    afterLongPressRef.current = true;
    openToolbar.claim(close);
    setTouchOpen(true);
  };

  useEffect(
    () => () => {
      pressRef.current?.stop();
      openToolbar.release(close);
    },
    [close]
  );

  // A touch anywhere else closes it. The reaction picker is elsewhere in
  // the DOM and keeps the toolbar up itself (`pickerOpen`).
  useEffect(() => {
    if (!touchOpen) return;
    const onDown = (e: PointerEvent) => {
      if (rowRef.current?.contains(e.target as Node)) return;
      setTouchOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [touchOpen]);

  const handlePointerDown = (e: React.PointerEvent) => {
    const target = e.target as Element;
    lastPointerTypeRef.current = e.pointerType;
    afterLongPressRef.current = false;
    pressedOnRef.current = toolbarRef.current?.contains(target)
      ? 'toolbar'
      : 'message';
    cancelPress();
    // The picker's portal bubbles here through React, outside the row.
    if (!rowRef.current?.contains(target)) return;
    const starts = startsLongPress({
      pointerType: e.pointerType,
      isPrimary: e.isPrimary,
      onControl: target.closest(HOLD_CONTROL_SELECTOR) !== null,
    });
    if (!starts) return;
    const timer = setTimeout(openByTouch, LONG_PRESS_MS);
    document.addEventListener('scroll', cancelPress, true);
    pressRef.current = {
      x: e.clientX,
      y: e.clientY,
      stop: () => {
        clearTimeout(timer);
        document.removeEventListener('scroll', cancelPress, true);
      },
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const start = pressRef.current;
    if (start && leftPress(start, { x: e.clientX, y: e.clientY })) {
      cancelPress();
    }
  };

  const handleClickCapture = (e: React.MouseEvent) => {
    const swallow = swallowsClick({
      afterLongPress: afterLongPressRef.current,
      onToolbar: !!toolbarRef.current?.contains(e.target as Node),
      pressedOn: pressedOnRef.current,
      keyboard: e.detail === 0,
    });
    if (!swallow) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    const native = e.nativeEvent as MouseEvent & {
      sourceCapabilities?: { firesTouchEvents?: boolean } | null;
    };
    const touch = isTouchContextMenu({
      lastPointerType: lastPointerTypeRef.current,
      firesTouchEvents: native.sourceCapabilities?.firesTouchEvents ?? null,
    });
    // One gesture's pointer type only: a later keyboard menu key must
    // not inherit an old touch.
    lastPointerTypeRef.current = null;
    if (!touch) return;
    // Prevented here, so the app-wide menu stands aside for this one.
    e.preventDefault();
    openByTouch();
  };

  const handleCopy = async () => {
    const text = message.content_text ?? '';
    if (!text) {
      toast.error(t('nothingToCopy'));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
    setTouchOpen(false);
  };

  const handlePickEmoji = (emoji: string) => {
    onReact(emoji);
    setPickerOpen(false);
    setTouchOpen(false);
  };

  const handleReply = () => {
    onReply();
    setTouchOpen(false);
  };

  // Location and contact cards can't be re-sent by the send core, and a
  // media message whose bytes never arrived has nothing to forward.
  const canForward = !!onForward && isForwardable(message);

  const handleForward = () => {
    onForward?.();
    setTouchOpen(false);
  };

  useContextMenuItems(rowRef, () => [
    { id: 'reply', label: t('reply'), icon: CornerUpLeft, onSelect: onReply },
    {
      id: 'react',
      label: t('react'),
      icon: SmilePlus,
      items: QUICK_EMOJIS.map((emoji) => ({
        id: `react-${emoji}`,
        label: emoji,
        onSelect: () => onReact(emoji),
      })),
    },
    ...(message.content_text
      ? [
          {
            id: 'copy',
            label: t('copyText'),
            icon: Copy,
            onSelect: () => void handleCopy(),
          },
        ]
      : []),
    ...(canForward
      ? [
          {
            id: 'forward',
            label: t('forward'),
            icon: Forward,
            onSelect: () => onForward?.(),
          },
        ]
      : []),
  ]);

  // Row alignment lives here (not in MessageBubble) so the `group/actions`
  // hover region matches the bubble's content width — hovering empty space
  // in the row no longer reveals the toolbar.
  return (
    <div
      className={cn(
        'flex w-full',
        isAgent ? 'justify-end' : 'justify-start',
        className
      )}
      ref={rowRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onClickCapture={handleClickCapture}
      onContextMenu={handleContextMenu}
      onBlur={(e) => {
        const to = e.relatedTarget;
        if (to && !rowRef.current?.contains(to)) setTouchOpen(false);
      }}
    >
      {/* `min-w-0` lets this flex child actually respect the 75% cap.
       *  Default `min-width: auto` lets content (a long quote preview,
       *  an unbroken URL) push past the cap and shove the row past
       *  100%, which used to bleed across into the contact-sidebar
       *  area. See issue #165. */}
      <div className="group/actions relative max-w-[85%] min-w-0 @lg/thread:max-w-[75%] @3xl/thread:max-w-[65%]">
        {children}
        {/* Out of reach until shown: at opacity 0 alone, a tap on the
            bubble's first line pressed a button nobody could see. Shown
            for keyboard focus only (`:focus-visible`), or tapping a
            photo would bring it up under the finger, and it would stay
            up after the button it was used for. */}
        <div
          ref={toolbarRef}
          data-message-toolbar=""
          data-touch-open={touchOpen || pickerOpen ? 'true' : undefined}
          className={cn(
            'border-border bg-popover/95 absolute -top-3 z-10 flex h-7 items-center gap-0.5 rounded-full border px-1 shadow-md backdrop-blur-sm transition-opacity',
            'pointer-events-none opacity-0',
            'group-hover/actions:pointer-events-auto group-hover/actions:opacity-100',
            'group-has-[:focus-visible]/actions:pointer-events-auto group-has-[:focus-visible]/actions:opacity-100',
            'data-[touch-open=true]:pointer-events-auto data-[touch-open=true]:opacity-100',
            isAgent ? 'end-3' : 'start-3'
          )}
        >
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger
              className="text-popover-foreground hover:bg-muted hover:text-foreground flex h-5 w-5 items-center justify-center rounded-full"
              aria-label={t('react')}
            >
              <SmilePlus className="h-3.5 w-3.5" />
            </PopoverTrigger>
            <PopoverContent
              className="flex w-auto flex-row gap-1 p-1.5"
              sideOffset={6}
            >
              {QUICK_EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => handlePickEmoji(e)}
                  className="hover:bg-muted flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none transition-transform hover:scale-125"
                  aria-label={t('reactWith', { emoji: e })}
                >
                  {e}
                </button>
              ))}
            </PopoverContent>
          </Popover>
          <button
            type="button"
            onClick={handleReply}
            className="text-popover-foreground hover:bg-muted hover:text-foreground flex h-5 w-5 items-center justify-center rounded-full"
            aria-label={t('reply')}
          >
            <CornerUpLeft className="h-3.5 w-3.5 rtl:rotate-180" />
          </button>
          {canForward && (
            <button
              type="button"
              onClick={handleForward}
              className="text-popover-foreground hover:bg-muted hover:text-foreground flex h-5 w-5 items-center justify-center rounded-full"
              aria-label={t('forward')}
            >
              <Forward className="h-3.5 w-3.5 rtl:rotate-180" />
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className="text-popover-foreground hover:bg-muted hover:text-foreground flex h-5 w-5 items-center justify-center rounded-full"
            aria-label={t('copyText')}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
