'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  Link as LinkIcon,
  Moon,
  RotateCw,
  Sun,
  SquareArrowOutUpRight,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import { useTheme } from '@/hooks/use-theme';
import {
  decideContextMenu,
  genericGroups,
  resolveLink,
  tidySeparators,
  type GenericAction,
  type ResolvedLink,
} from '@/lib/context-menu/resolve';
import {
  findRegisteredItems,
  isSeparator,
  isSubmenu,
  type ContextMenuAction,
  type ContextMenuEntry,
} from './registry';

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const NATIVE_MARK_SELECTOR = '[data-native-context-menu]';
const POPUP_SELECTOR = '[data-slot="context-menu-content"]';

/** Writes `text` to the clipboard with the inbox's toast feedback. */
export async function copyWithToast(
  text: string,
  messages: { copied: string; failed: string }
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(messages.copied);
  } catch {
    toast.error(messages.failed);
  }
}

interface MenuModel {
  x: number;
  y: number;
  sections: ContextMenuEntry[][];
}

interface Captured {
  items: readonly ContextMenuEntry[];
  link: ResolvedLink | null;
  image: ResolvedLink | null;
  selectionText: string;
}

/**
 * The app's own right-click menu, mounted once in the dashboard shell.
 * One window-level `contextmenu` listener builds the menu from the
 * target: registered item actions (`useContextMenuItems`), then link,
 * image, selected text and page actions. The decisions are pure, in
 * `lib/context-menu/resolve.ts`.
 */
export function AppContextMenu() {
  const t = useTranslations('ContextMenu');
  const router = useRouter();
  const { mode, toggleMode } = useTheme();
  const [open, setOpen] = useState(false);
  // Kept after close so the exit animation has its content.
  const [menu, setMenu] = useState<MenuModel | null>(null);
  const openRef = useRef(false);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // The action builders read the latest render's values at right-click
  // time; the listener itself is registered once.
  const buildRef = useRef<(captured: Captured) => ContextMenuEntry[][]>(
    () => []
  );
  useEffect(() => {
    buildRef.current = (captured) => {
      const copied = { copied: t('copied'), failed: t('copyFailed') };
      const action = (a: GenericAction): ContextMenuAction | null => {
        const { link, image, selectionText } = captured;
        switch (a) {
          case 'link.open':
            if (!link) return null;
            return {
              id: a,
              label: t('openLink'),
              icon: ExternalLink,
              onSelect: () => {
                if (link.sameOrigin) router.push(link.path);
                else window.location.assign(link.url);
              },
            };
          case 'link.openNewTab':
            if (!link) return null;
            return {
              id: a,
              label: t('openLinkNewTab'),
              icon: SquareArrowOutUpRight,
              onSelect: () =>
                void window.open(link.url, '_blank', 'noopener,noreferrer'),
            };
          case 'link.copy':
            if (!link) return null;
            return {
              id: a,
              label: t('copyLinkAddress'),
              icon: LinkIcon,
              onSelect: () => void copyWithToast(link.url, copied),
            };
          case 'image.openNewTab':
            if (!image) return null;
            return {
              id: a,
              label: t('openImageNewTab'),
              icon: ImageIcon,
              onSelect: () =>
                void window.open(image.url, '_blank', 'noopener,noreferrer'),
            };
          case 'image.copy':
            if (!image) return null;
            return {
              id: a,
              label: t('copyImageAddress'),
              icon: LinkIcon,
              onSelect: () => void copyWithToast(image.url, copied),
            };
          case 'selection.copy':
            return {
              id: a,
              label: t('copy'),
              icon: Copy,
              onSelect: () => void copyWithToast(selectionText, copied),
            };
          case 'page.back':
            return {
              id: a,
              label: t('back'),
              icon: ArrowLeft,
              onSelect: () => router.back(),
            };
          case 'page.forward':
            return {
              id: a,
              label: t('forward'),
              icon: ArrowRight,
              onSelect: () => router.forward(),
            };
          case 'page.reload':
            return {
              id: a,
              label: t('reload'),
              icon: RotateCw,
              onSelect: () => window.location.reload(),
            };
          case 'page.copyLink':
            return {
              id: a,
              label: t('copyPageLink'),
              icon: LinkIcon,
              onSelect: () => void copyWithToast(window.location.href, copied),
            };
          case 'page.toggleMode':
            return {
              id: a,
              label: mode === 'dark' ? t('lightMode') : t('darkMode'),
              icon: mode === 'dark' ? Sun : Moon,
              onSelect: toggleMode,
            };
        }
      };
      const sections: ContextMenuEntry[][] = [];
      const items = tidySeparators(captured.items, isSeparator);
      if (items.length > 0) sections.push(items);
      for (const group of genericGroups(captured)) {
        const actions = group.actions
          .map(action)
          .filter((a): a is ContextMenuAction => a !== null);
        if (actions.length > 0) sections.push(actions);
      }
      return sections;
    };
  });

  useEffect(() => {
    // On window, not document: React's own listeners sit on the root
    // and must run first, so a component that prevents the event (the
    // inbox's touch long-press) is seen as `defaultPrevented` here.
    function onContextMenu(e: MouseEvent) {
      const target =
        e.target instanceof Element
          ? e.target
          : ((e.target as Node | null)?.parentElement ?? null);
      if (openRef.current) {
        // A right-click while ours is open lands on its backdrop or on
        // the popup; neither should get the browser menu. Closing (not
        // reopening) keeps one menu at a time.
        e.preventDefault();
        if (!target?.closest(POPUP_SELECTOR)) setOpen(false);
        return;
      }
      const decision = decideContextMenu({
        shift: e.shiftKey,
        editable: !!target?.closest(EDITABLE_SELECTOR),
        nativeMarked: !!target?.closest(NATIVE_MARK_SELECTOR),
        defaultPrevented: e.defaultPrevented,
      });
      if (decision !== 'app') return;
      e.preventDefault();

      const pageUrl = window.location.href;
      const anchor = target?.closest('a[href]');
      const img = target?.closest('img');
      const sections = buildRef.current({
        items: findRegisteredItems(target),
        link: anchor ? resolveLink(anchor.getAttribute('href'), pageUrl) : null,
        image: img
          ? resolveLink(img.currentSrc || img.getAttribute('src'), pageUrl)
          : null,
        selectionText: window.getSelection()?.toString() ?? '',
      });

      // The keyboard's menu key reports (0, 0); open beside the
      // focused element instead of in the corner.
      let { clientX: x, clientY: y } = e;
      if (x === 0 && y === 0 && target) {
        const rect = target.getBoundingClientRect();
        x = rect.left;
        y = rect.bottom;
      }
      setMenu({ x, y, sections });
      setOpen(true);
    }
    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
  }, []);

  const anchor = menu
    ? {
        getBoundingClientRect: () =>
          DOMRect.fromRect({ x: menu.x, y: menu.y, width: 0, height: 0 }),
      }
    : undefined;

  return (
    <ContextMenu open={open} onOpenChange={(next) => setOpen(next)}>
      <ContextMenuContent anchor={anchor}>
        {menu?.sections.map((section, i) => (
          <ContextMenuGroup key={i}>
            {i > 0 && <ContextMenuSeparator />}
            {section.map((entry, j) => renderEntry(entry, `${i}-${j}`))}
          </ContextMenuGroup>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function renderEntry(entry: ContextMenuEntry, key: string) {
  if (isSeparator(entry)) return <ContextMenuSeparator key={key} />;
  const Icon = entry.icon;
  if (isSubmenu(entry)) {
    return (
      <ContextMenuSub key={key}>
        <ContextMenuSubTrigger disabled={entry.disabled}>
          {Icon && <Icon />}
          {entry.label}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {entry.items.map((item, k) => renderEntry(item, `${key}-${k}`))}
        </ContextMenuSubContent>
      </ContextMenuSub>
    );
  }
  return (
    <ContextMenuItem
      key={key}
      disabled={entry.disabled}
      variant={entry.destructive ? 'destructive' : 'default'}
      onClick={() => entry.onSelect()}
    >
      {Icon && <Icon />}
      {entry.label}
      {entry.shortcut && (
        <ContextMenuShortcut>{entry.shortcut}</ContextMenuShortcut>
      )}
    </ContextMenuItem>
  );
}
