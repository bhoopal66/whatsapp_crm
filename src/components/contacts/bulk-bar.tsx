'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Loader2, Megaphone, Tag, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { chatTagColor } from '@/lib/chat-tags/style';
import type { ChatTagTree } from '@/lib/chat-tags/tree';
import { cn } from '@/lib/utils';

/** What the picker hands back: `undefined` sub = keep the current one. */
export interface ChatTagChoice {
  chatTagId: string | null;
  subTagId: string | null | undefined;
}

/**
 * The Contacts bulk bar: sticks to the bottom of the scrolling page,
 * wraps on a narrow screen. Tagging and campaigns are agent-and-up
 * (`canAct`); delete keeps its own confirm dialog in the page.
 */
export function BulkBar({
  count,
  canAct,
  tree,
  onClear,
  onDelete,
  onApplyTag,
  onAddToCampaign,
}: {
  count: number;
  canAct: boolean;
  tree: ChatTagTree;
  onClear: () => void;
  onDelete: () => void;
  onApplyTag: (choice: ChatTagChoice) => Promise<void>;
  onAddToCampaign: () => void;
}) {
  const t = useTranslations('ContactsTable');
  const tPage = useTranslations('Contacts.page');
  const [tagOpen, setTagOpen] = useState(false);
  // /broadcasts/new is admin-only: below that the button is a dead end.
  const canCampaign = useCan('edit-settings');
  return (
    <div
      role="region"
      aria-label={t('bulkBar')}
      className="bg-card border-border sticky bottom-3 z-30 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border px-4 py-2 shadow-md"
    >
      <p className="text-foreground text-sm font-medium">
        {tPage('selectedCount', { count })}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="text-muted-foreground hover:text-foreground"
        >
          {tPage('clearSelection')}
        </Button>
        <GatedButton
          variant="outline"
          size="sm"
          canAct={canAct}
          gateReason="tag contacts"
          onClick={() => setTagOpen(true)}
        >
          <Tag className="size-4" />
          {t('setChatTag')}
        </GatedButton>
        {canCampaign && (
          <GatedButton
            variant="outline"
            size="sm"
            canAct={canAct}
            gateReason="start a campaign"
            onClick={onAddToCampaign}
          >
            <Megaphone className="size-4" />
            {t('addToCampaign')}
          </GatedButton>
        )}
        <GatedButton
          variant="destructive"
          size="sm"
          canAct={canAct}
          gateReason="delete contacts"
          onClick={onDelete}
        >
          <Trash2 className="size-4" />
          {tPage('deleteSelected')}
        </GatedButton>
      </div>
      <ChatTagPickerDialog
        open={tagOpen}
        onOpenChange={setTagOpen}
        count={count}
        tree={tree}
        onApply={onApplyTag}
      />
    </div>
  );
}

function ChatTagPickerDialog({
  open,
  onOpenChange,
  count,
  tree,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  tree: ChatTagTree;
  onApply: (choice: ChatTagChoice) => Promise<void>;
}) {
  const t = useTranslations('ContactsTable');
  const tPage = useTranslations('Contacts.page');
  // 'none' = nothing picked yet; null = "remove the tag".
  const [main, setMain] = useState<string | null | 'none'>('none');
  const [sub, setSub] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const mainTag = tree.mains.find((m) => m.id === main) ?? null;

  async function apply() {
    if (main === 'none') return;
    setSaving(true);
    try {
      await onApply({
        chatTagId: main,
        // A main tag alone keeps any sub-tag the chat already has under
        // it; picking one sets it; removing the tag clears both.
        subTagId: main === null ? null : (sub ?? undefined),
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setMain('none');
          setSub(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('tagDialogTitle', { count })}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('tagDialogDesc')}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {tree.mains.length === 0 && (
            <p className="text-muted-foreground py-3 text-center text-sm">
              {tPage('noChatTagsYet')}
            </p>
          )}
          {tree.mains.map((m) => (
            <TagOption
              key={m.id}
              label={m.name}
              color={m.color}
              selected={main === m.id}
              onSelect={() => {
                setMain(m.id);
                setSub(null);
              }}
            />
          ))}
          {tree.mains.length > 0 && (
            <TagOption
              label={t('removeTag')}
              selected={main === null}
              onSelect={() => {
                setMain(null);
                setSub(null);
              }}
            />
          )}
        </div>
        {mainTag && mainTag.subs.length > 0 && (
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs font-medium">
              {mainTag.sub_tag_title || t('subTag')} {t('optional')}
            </p>
            <div className="max-h-40 space-y-1 overflow-y-auto">
              <TagOption
                label={t('keepSubTag')}
                selected={sub === null}
                onSelect={() => setSub(null)}
              />
              {mainTag.subs.map((s) => (
                <TagOption
                  key={s.id}
                  label={s.name}
                  color={s.color}
                  selected={sub === s.id}
                  onSelect={() => setSub(s.id)}
                />
              ))}
            </div>
          </div>
        )}
        <DialogFooter className="bg-popover border-border">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {tPage('cancel')}
          </Button>
          <Button onClick={apply} disabled={main === 'none' || saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t('applyTag')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One choice: a colour dot, the name and a check when picked. */
function TagOption({
  label,
  color,
  selected,
  onSelect,
}: {
  label: string;
  color?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'hover:bg-muted flex min-h-9 w-full items-center gap-2.5 rounded-md px-2 text-start text-sm',
        selected && 'bg-muted font-medium'
      )}
    >
      {color ? (
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: chatTagColor(color) }}
        />
      ) : (
        <span aria-hidden className="size-2 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected && <Check aria-hidden className="size-4 shrink-0" />}
    </button>
  );
}
