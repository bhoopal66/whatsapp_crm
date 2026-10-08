'use client';

import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, Loader2, Trash2 } from 'lucide-react';

import type { ChatTag } from '@/types';
import type { ChatTagNode } from '@/lib/chat-tags/tree';
import {
  CHAT_TAG_COLORS,
  CHAT_TAG_NAME_MAX,
  CHAT_TAG_SUB_TITLE_MAX,
  normalizeChatTagName,
  normalizeSubTagTitle,
  validateChatTagName,
} from '@/lib/chat-tags/edit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * The pieces of Settings → Chat tags that are not the list itself: the
 * colour swatches, the two edit dialogs and the delete confirmation,
 * plus the one rule that turns a PostgREST answer into what the admin
 * is told. The dialogs only validate and collect values; the panel
 * owns every write, so it can hold one in-flight guard for the screen.
 */

export type ChatTagWriteOutcome = 'ok' | 'duplicate' | 'forbidden' | 'failed';

/**
 * How one write against `chat_tags` came out. Every write asks for
 * `.select()` because RLS does not always raise: an UPDATE or DELETE
 * the caller may not make is filtered down to zero rows and reported
 * as a success with nothing in it.
 */
export function chatTagWriteOutcome(res: {
  error: { code?: string } | null;
  data: unknown[] | null;
}): ChatTagWriteOutcome {
  if (res.error) {
    if (res.error.code === '23505') return 'duplicate';
    if (res.error.code === '42501') return 'forbidden';
    return 'failed';
  }
  return res.data && res.data.length > 0 ? 'ok' : 'forbidden';
}

export type ChatTagNameProblem = ReturnType<typeof validateChatTagName>;

/** The inline message for a name problem; `parent` names a sub-tag's main tag. */
export function useChatTagNameError(): (
  problem: ChatTagNameProblem,
  parent: string | null
) => string | null {
  const t = useTranslations('Settings.chatTags');
  return (problem, parent) => {
    switch (problem) {
      case 'empty':
        return t('errors.empty');
      case 'too_long':
        return t('errors.tooLong', { max: CHAT_TAG_NAME_MAX });
      case 'duplicate':
        return parent === null
          ? t('errors.duplicateMain')
          : t('errors.duplicateSub', { parent });
      default:
        return null;
    }
  };
}

export function ChatTagColorPicker({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string;
  onChange: (color: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations('Settings.chatTags');
  return (
    <div
      role="group"
      aria-label={t('colorLabel')}
      className={cn('flex flex-wrap gap-1.5', className)}
    >
      {CHAT_TAG_COLORS.map((color) => {
        const label = t(`colors.${color.name}`);
        const selected = value.toLowerCase() === color.value;
        return (
          <button
            key={color.value}
            type="button"
            onClick={() => onChange(color.value)}
            disabled={disabled}
            aria-label={t('useColor', { color: label })}
            aria-pressed={selected}
            title={label}
            className={cn(
              'size-6 rounded-md transition-transform hover:scale-110 disabled:pointer-events-none disabled:opacity-50',
              selected && 'outline-primary outline-2 outline-offset-2'
            )}
            style={{ backgroundColor: color.value }}
          />
        );
      })}
    </div>
  );
}

function FieldError({ id, message }: { id: string; message: string | null }) {
  if (!message) return null;
  return (
    <p id={id} className="text-destructive text-xs">
      {message}
    </p>
  );
}

/**
 * Editing a main tag. Creation is the panel's inline row; this is for
 * renaming, recolouring and the sub-tag heading.
 */
export function MainTagDialog({
  tag,
  siblings,
  busy,
  saving,
  onSave,
  onDelete,
  onClose,
}: {
  tag: ChatTagNode;
  siblings: readonly ChatTag[];
  busy: boolean;
  saving: boolean;
  onSave: (values: {
    name: string;
    color: string;
    sub_tag_title: string | null;
  }) => Promise<ChatTagWriteOutcome | null>;
  onDelete: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('Settings.chatTags');
  const nameError = useChatTagNameError();
  const ids = useId();
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);
  const [title, setTitle] = useState(tag.sub_tag_title ?? '');
  const [problem, setProblem] = useState<ChatTagNameProblem>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const found = validateChatTagName(name, siblings, tag.id);
    setProblem(found);
    if (found) return;
    const outcome = await onSave({
      name: normalizeChatTagName(name),
      color,
      sub_tag_title: normalizeSubTagTitle(title),
    });
    if (outcome === 'duplicate') setProblem('duplicate');
  }

  const error = nameError(problem, null);

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('editMainTitle')}</DialogTitle>
            <DialogDescription>{t('editMainDesc')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor={`${ids}-name`}>{t('nameLabel')}</Label>
            <Input
              id={`${ids}-name`}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setProblem(null);
              }}
              maxLength={CHAT_TAG_NAME_MAX}
              disabled={busy}
              aria-invalid={!!error}
              aria-describedby={error ? `${ids}-name-error` : undefined}
            />
            <FieldError id={`${ids}-name-error`} message={error} />
          </div>

          <div className="grid gap-2">
            <span className="text-sm font-medium">{t('colorLabel')}</span>
            <ChatTagColorPicker
              value={color}
              onChange={setColor}
              disabled={busy}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor={`${ids}-title`}>
              {t('subTitleLabel')}
              <span className="text-muted-foreground font-normal">
                ({t('subTitleOptional')})
              </span>
            </Label>
            <Input
              id={`${ids}-title`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('subTitlePlaceholder')}
              maxLength={CHAT_TAG_SUB_TITLE_MAX}
              disabled={busy}
              aria-describedby={`${ids}-title-help`}
            />
            <p
              id={`${ids}-title-help`}
              className="text-muted-foreground text-xs"
            >
              {t('subTitleHelp')}
            </p>
          </div>

          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="destructive"
              onClick={onDelete}
              disabled={busy}
            >
              <Trash2 className="size-4" />
              {t('deleteButton')}
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                disabled={busy}
              >
                {t('cancel')}
              </Button>
              <Button type="submit" disabled={busy}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {t('save')}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Creating (`tag` null) or editing a sub-tag of `parent`. Moving runs
 * at once rather than on Save: it writes positions, not this form.
 */
export function SubTagDialog({
  parent,
  tag,
  busy,
  saving,
  moving,
  onSave,
  onMove,
  onDelete,
  onClose,
}: {
  parent: ChatTagNode;
  tag: ChatTag | null;
  busy: boolean;
  saving: boolean;
  moving: boolean;
  onSave: (values: {
    name: string;
    color: string;
  }) => Promise<ChatTagWriteOutcome | null>;
  onMove: (dir: 'up' | 'down') => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('Settings.chatTags');
  const nameError = useChatTagNameError();
  const ids = useId();
  const [name, setName] = useState(tag?.name ?? '');
  const [color, setColor] = useState(tag?.color ?? parent.color);
  const [problem, setProblem] = useState<ChatTagNameProblem>(null);

  const heading = parent.sub_tag_title ?? t('subTagFallback');
  const index = tag ? parent.subs.findIndex((s) => s.id === tag.id) : -1;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const found = validateChatTagName(name, parent.subs, tag?.id);
    setProblem(found);
    if (found) return;
    const outcome = await onSave({ name: normalizeChatTagName(name), color });
    if (outcome === 'duplicate') setProblem('duplicate');
  }

  const error = nameError(problem, parent.name);

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>
              {tag
                ? t('edit', { name: tag.name })
                : t('addSub', { title: heading })}
            </DialogTitle>
            <DialogDescription>
              {t('subDesc', { parent: parent.name })}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor={`${ids}-name`}>{t('nameLabel')}</Label>
            <Input
              id={`${ids}-name`}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setProblem(null);
              }}
              maxLength={CHAT_TAG_NAME_MAX}
              disabled={busy}
              autoFocus={!tag}
              aria-invalid={!!error}
              aria-describedby={error ? `${ids}-name-error` : undefined}
            />
            <FieldError id={`${ids}-name-error`} message={error} />
          </div>

          <div className="grid gap-2">
            <span className="text-sm font-medium">{t('colorLabel')}</span>
            <ChatTagColorPicker
              value={color}
              onChange={setColor}
              disabled={busy}
            />
          </div>

          {tag ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onMove('up')}
                disabled={busy || index <= 0}
              >
                {moving ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ArrowLeft />
                )}
                {t('moveEarlier')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onMove('down')}
                disabled={
                  busy || index === -1 || index >= parent.subs.length - 1
                }
              >
                {t('moveLater')}
                <ArrowRight />
              </Button>
            </div>
          ) : null}

          <DialogFooter className={tag ? 'sm:justify-between' : undefined}>
            {tag ? (
              <Button
                type="button"
                variant="destructive"
                onClick={onDelete}
                disabled={busy}
              >
                <Trash2 className="size-4" />
                {t('deleteButton')}
              </Button>
            ) : null}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                disabled={busy}
              >
                {t('cancel')}
              </Button>
              <Button type="submit" disabled={busy}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {t('save')}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Says what a delete does before it happens. `count` is the number of
 * chats carrying the tag: `'loading'` while it is being counted, null
 * when the count failed (the wording then stays truthful without it).
 */
export function DeleteChatTagDialog({
  tag,
  subs,
  count,
  busy,
  deleting,
  onConfirm,
  onClose,
}: {
  tag: ChatTag;
  /** How many sub-tags go with it; 0 for a sub-tag. */
  subs: number;
  count: number | null | 'loading';
  busy: boolean;
  deleting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('Settings.chatTags');
  const isMain = tag.parent_id === null;

  let message: string;
  if (count === 'loading') message = t('counting');
  else if (isMain)
    message =
      count === null
        ? t('deleteMainConfirmUncounted', { name: tag.name, subs })
        : t('deleteMainConfirm', { name: tag.name, count, subs });
  else
    message =
      count === null
        ? t('deleteSubConfirmUncounted', { name: tag.name })
        : t('deleteSubConfirm', { name: tag.name, count });

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {isMain ? t('deleteMainTitle') : t('deleteSubTitle')}
          </DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={busy || count === 'loading'}
          >
            {deleting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('deleting')}
              </>
            ) : (
              t('deleteButton')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
