'use client';

import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

/**
 * The More menu is a plain array, drawn as a dropdown or as the phone's
 * bottom sheet: anything that belongs in it is one more entry.
 */
export type MoreItem =
  | { kind: 'separator'; id: string }
  | {
      kind: 'radio';
      id: string;
      label: string;
      value: string;
      options: readonly { value: string; label: string }[];
      onChange: (value: string) => void;
    }
  | {
      kind: 'toggle';
      id: string;
      label: string;
      icon: ReactNode;
      checked: boolean;
      onChange: (checked: boolean) => void;
    }
  | {
      kind: 'action';
      id: string;
      label: string;
      icon: ReactNode;
      shortcut?: string;
      disabled?: boolean;
      pressed?: boolean;
      onClick: () => void;
    }
  | {
      /** The sheet only: the dropdown form has its own Reactions button. */
      kind: 'reactions';
      id: string;
      emojis: readonly { emoji: string; label: string }[];
      onReact: (emoji: string) => void;
    };

/** The entries of a DropdownMenuContent. */
export function MoreDropdownItems({ items }: { items: readonly MoreItem[] }) {
  return items.map((item) => {
    switch (item.kind) {
      case 'separator':
        return <DropdownMenuSeparator key={item.id} />;
      case 'radio':
        return (
          <DropdownMenuGroup key={item.id}>
            <DropdownMenuLabel>{item.label}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={item.value}
              onValueChange={(v) => item.onChange(String(v))}
            >
              {item.options.map((o) => (
                <DropdownMenuRadioItem key={o.value} value={o.value}>
                  {o.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        );
      case 'toggle':
        return (
          <DropdownMenuCheckboxItem
            key={item.id}
            checked={item.checked}
            onCheckedChange={item.onChange}
          >
            {item.icon}
            {item.label}
          </DropdownMenuCheckboxItem>
        );
      case 'action':
        return (
          <DropdownMenuItem
            key={item.id}
            disabled={item.disabled}
            onClick={item.onClick}
          >
            {item.icon}
            {item.label}
            {item.shortcut && (
              <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>
            )}
          </DropdownMenuItem>
        );
      case 'reactions':
        return null;
    }
  });
}

const ROW = 'h-11 w-full justify-start gap-3 rounded-xl';

/** The same entries as a bottom sheet; an entry closes it as it runs. */
export function MoreSheet({
  open,
  onOpenChange,
  title,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  items: readonly MoreItem[];
}) {
  const closing = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };
  const entry = (item: MoreItem) => {
    switch (item.kind) {
      case 'separator':
        return <div key={item.id} className="bg-border mx-2 my-1 h-px" />;
      case 'radio':
        return (
          <div
            key={item.id}
            role="radiogroup"
            aria-label={item.label}
            className="flex flex-col gap-1.5 px-2 py-1.5"
          >
            <span className="text-muted-foreground text-xs">{item.label}</span>
            <div className="bg-card-2 flex gap-1 rounded-xl p-1">
              {item.options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={o.value === item.value}
                  className={cn(
                    'h-9 flex-1 rounded-lg text-sm transition-colors duration-150 ease-out motion-reduce:transition-none',
                    o.value === item.value &&
                      'bg-primary text-primary-foreground'
                  )}
                  onClick={closing(() => item.onChange(o.value))}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        );
      case 'toggle':
        return (
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            className={ROW}
            aria-pressed={item.checked}
            onClick={closing(() => item.onChange(!item.checked))}
          >
            {item.icon}
            <span className="flex-1 text-start">{item.label}</span>
            {item.checked && <Check aria-hidden />}
          </Button>
        );
      case 'action':
        return (
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            className={ROW}
            disabled={item.disabled}
            aria-pressed={item.pressed}
            onClick={closing(item.onClick)}
          >
            {item.icon}
            <span className="flex-1 text-start">{item.label}</span>
          </Button>
        );
      case 'reactions':
        return (
          <div key={item.id} className="flex justify-between px-1 pb-1">
            {item.emojis.map(({ emoji, label }) => (
              <Button
                key={emoji}
                type="button"
                variant="ghost"
                size="icon-lg"
                className="rounded-xl text-xl"
                aria-label={label}
                onClick={closing(() => item.onReact(emoji))}
              >
                {emoji}
              </Button>
            ))}
          </div>
        );
    }
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        data-mode="dark"
        className="max-h-[85dvh] gap-1 rounded-t-2xl pb-4"
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div className="flex min-h-0 flex-col overflow-y-auto px-2">
          {items.map(entry)}
        </div>
      </SheetContent>
    </Sheet>
  );
}
