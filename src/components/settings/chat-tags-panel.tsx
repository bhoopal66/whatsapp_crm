'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';

import type { ChatTag } from '@/types';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useChatTags } from '@/hooks/use-chat-tags';
import type { ChatTagNode } from '@/lib/chat-tags/tree';
import {
  CHAT_TAG_COLORS,
  CHAT_TAG_NAME_MAX,
  moveChatTag,
  nextChatTagPosition,
  normalizeChatTagName,
  validateChatTagName,
} from '@/lib/chat-tags/edit';
import { chatTagChipStyle, chatTagColor } from '@/lib/chat-tags/style';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

import {
  ChatTagColorPicker,
  DeleteChatTagDialog,
  MainTagDialog,
  SubTagDialog,
  chatTagWriteOutcome,
  useChatTagNameError,
  type ChatTagNameProblem,
  type ChatTagWriteOutcome,
} from './chat-tag-dialogs';
import { SettingsPanelHead } from './settings-panel-head';

type DialogState =
  | { kind: 'main'; id: string }
  | { kind: 'sub'; parentId: string; id: string | null }
  | { kind: 'delete'; id: string; count: number | null | 'loading' }
  | null;

const DEFAULT_COLOR: string = CHAT_TAG_COLORS[3].value;

function chatTags() {
  return createClient().from('chat_tags');
}

/**
 * Settings → Chat tags (migration 075): the admin list of main tags and
 * their sub-tags that chats are labelled with.
 *
 * Dialogs are resolved by id against the live tree on every render, so
 * a tag another admin deleted simply closes its dialog after the next
 * reload instead of editing a ghost.
 */
export function ChatTagsPanel() {
  const t = useTranslations('Settings.chatTags');
  const nameError = useChatTagNameError();
  const { accountId } = useAuth();
  const { tags, tree, reload } = useChatTags();

  // One write at a time for the whole screen. The ref is the guard (a
  // double click lands before React re-renders the disabled button);
  // the state is what disables the controls and picks the spinner.
  const inFlight = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const busy = pending !== null;

  const [dialog, setDialog] = useState<DialogState>(null);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(DEFAULT_COLOR);
  const [newProblem, setNewProblem] = useState<ChatTagNameProblem>(null);

  /**
   * Run one write, tell the admin what failed, and reload. The reload
   * runs after failures too and finishes before the controls unlock:
   * a refused write may mean the list changed under us, and a move
   * computed from stale positions would scramble the order.
   * Null means another write was already running and nothing was sent.
   */
  async function write(
    key: string,
    op: () => Promise<ChatTagWriteOutcome>,
    success?: string
  ): Promise<ChatTagWriteOutcome | null> {
    if (inFlight.current) return null;
    inFlight.current = true;
    setPending(key);
    try {
      let outcome: ChatTagWriteOutcome;
      try {
        outcome = await op();
      } catch (err) {
        console.error('[chat-tags] write failed', err);
        outcome = 'failed';
      }
      if (outcome === 'forbidden') toast.error(t('errors.forbidden'));
      else if (outcome === 'failed') toast.error(t('errors.failed'));
      else if (outcome === 'ok' && success) toast.success(success);
      await reload();
      return outcome;
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  function closeDialog() {
    if (!inFlight.current) setDialog(null);
  }

  async function addMain() {
    const problem = validateChatTagName(newName, tree.mains);
    setNewProblem(problem);
    if (problem || !accountId) return;
    const outcome = await write(
      'create',
      async () =>
        chatTagWriteOutcome(
          await chatTags()
            .insert({
              account_id: accountId,
              parent_id: null,
              name: normalizeChatTagName(newName),
              color: newColor,
              position: nextChatTagPosition(tree.mains),
            })
            .select('id')
        ),
      t('created')
    );
    if (outcome === 'ok') setNewName('');
    else if (outcome === 'duplicate') setNewProblem('duplicate');
  }

  function move(siblings: readonly ChatTag[], id: string, dir: 'up' | 'down') {
    const writes = moveChatTag(siblings, id, dir);
    if (writes.length === 0) return;
    void write(`move:${id}`, async () => {
      for (const w of writes) {
        const outcome = chatTagWriteOutcome(
          await chatTags()
            .update({ position: w.position })
            .eq('id', w.id)
            .select('id')
        );
        if (outcome !== 'ok') return outcome;
      }
      return 'ok';
    });
  }

  async function update(
    id: string,
    patch: Partial<Pick<ChatTag, 'name' | 'color' | 'sub_tag_title'>>
  ) {
    const outcome = await write(
      'save',
      async () =>
        chatTagWriteOutcome(
          await chatTags().update(patch).eq('id', id).select('id')
        ),
      t('saved')
    );
    if (outcome === 'ok') setDialog(null);
    return outcome;
  }

  async function addSub(
    parent: ChatTagNode,
    values: { name: string; color: string }
  ) {
    if (!accountId) return null;
    const outcome = await write(
      'save',
      async () =>
        chatTagWriteOutcome(
          await chatTags()
            .insert({
              account_id: accountId,
              parent_id: parent.id,
              name: values.name,
              color: values.color,
              position: nextChatTagPosition(parent.subs),
            })
            .select('id')
        ),
      t('created')
    );
    if (outcome === 'ok') setDialog(null);
    return outcome;
  }

  async function askDelete(tag: ChatTag) {
    if (inFlight.current) return;
    setDialog({ kind: 'delete', id: tag.id, count: 'loading' });
    const column = tag.parent_id === null ? 'chat_tag_id' : 'chat_sub_tag_id';
    let count: number | null = null;
    try {
      const res = await createClient()
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq(column, tag.id);
      if (res.error) console.error('[chat-tags] usage count failed', res.error);
      else count = typeof res.count === 'number' ? res.count : null;
    } catch (err) {
      console.error('[chat-tags] usage count failed', err);
    }
    setDialog((d) =>
      d?.kind === 'delete' && d.id === tag.id ? { ...d, count } : d
    );
  }

  async function remove(tag: ChatTag) {
    const outcome = await write(
      'delete',
      async () =>
        chatTagWriteOutcome(
          await chatTags().delete().eq('id', tag.id).select('id')
        ),
      t('deleted')
    );
    if (outcome === 'ok' || outcome === 'forbidden') setDialog(null);
  }

  const newError = nameError(newProblem, null);

  return (
    <section className="animate-in fade-in-50 max-w-3xl space-y-4 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Card>
        <CardContent className="space-y-4">
          {tags === null ? (
            <div
              className="flex items-center justify-center py-8"
              role="status"
              aria-label={t('loading')}
            >
              <Loader2 className="text-primary size-6 animate-spin" />
            </div>
          ) : (
            <>
              {tree.mains.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t('empty')}</p>
              ) : (
                <ul className="space-y-2">
                  {tree.mains.map((main, i) => {
                    const heading = main.sub_tag_title ?? t('subTagFallback');
                    const summary: string[] = [];
                    if (main.sub_tag_title) summary.push(main.sub_tag_title);
                    if (main.sub_tag_title || main.subs.length > 0) {
                      summary.push(t('subCount', { count: main.subs.length }));
                    }
                    const moving = pending === `move:${main.id}`;
                    return (
                      <li
                        key={main.id}
                        className="border-border bg-card rounded-lg border p-3"
                      >
                        <div className="flex items-center gap-3">
                          <span
                            aria-hidden
                            className="size-3 shrink-0 rounded-full"
                            style={{
                              backgroundColor: chatTagColor(main.color),
                            }}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-foreground truncate text-sm font-medium">
                              {main.name}
                            </div>
                            {summary.length > 0 ? (
                              <div className="text-muted-foreground truncate text-xs">
                                {summary.join(' · ')}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-0.5">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('moveUp', { name: main.name })}
                              disabled={busy || i === 0}
                              onClick={() => move(tree.mains, main.id, 'up')}
                            >
                              {moving ? (
                                <Loader2 className="animate-spin" />
                              ) : (
                                <ArrowUp />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('moveDown', { name: main.name })}
                              disabled={busy || i === tree.mains.length - 1}
                              onClick={() => move(tree.mains, main.id, 'down')}
                            >
                              <ArrowDown />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('edit', { name: main.name })}
                              disabled={busy}
                              onClick={() =>
                                setDialog({ kind: 'main', id: main.id })
                              }
                            >
                              <Pencil />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-destructive hover:text-destructive"
                              aria-label={t('delete', { name: main.name })}
                              disabled={busy}
                              onClick={() => askDelete(main)}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </div>

                        <div className="mt-2.5 flex flex-wrap gap-1.5 pl-6">
                          {main.subs.map((sub) => (
                            <button
                              key={sub.id}
                              type="button"
                              title={t('edit', { name: sub.name })}
                              disabled={busy}
                              onClick={() =>
                                setDialog({
                                  kind: 'sub',
                                  parentId: main.id,
                                  id: sub.id,
                                })
                              }
                              className="text-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-50"
                              style={chatTagChipStyle(sub.color)}
                            >
                              <span
                                aria-hidden
                                className="size-2 rounded-full"
                                style={{
                                  backgroundColor: chatTagColor(sub.color),
                                }}
                              />
                              {sub.name}
                            </button>
                          ))}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              setDialog({
                                kind: 'sub',
                                parentId: main.id,
                                id: null,
                              })
                            }
                            className="border-border text-muted-foreground hover:bg-muted hover:text-foreground inline-flex items-center gap-1 rounded-full border border-dashed px-2.5 py-1 text-xs transition-colors disabled:opacity-50"
                          >
                            <Plus className="size-3" />
                            {t('addSub', { title: heading })}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* Inline create row, as in the contact-tag manager. */}
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Input
                    aria-label={t('newMainLabel')}
                    placeholder={t('newMainPlaceholder')}
                    value={newName}
                    onChange={(e) => {
                      setNewName(e.target.value);
                      setNewProblem(null);
                    }}
                    onKeyDown={(e) => {
                      // Enter that confirms a Korean/IME composition is
                      // not a submit; it would add a half-typed name.
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void addMain();
                      }
                    }}
                    disabled={busy}
                    maxLength={CHAT_TAG_NAME_MAX}
                    aria-invalid={!!newError}
                    className="min-w-[180px] flex-1"
                  />
                  <ChatTagColorPicker
                    value={newColor}
                    onChange={setNewColor}
                    disabled={busy}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void addMain()}
                    disabled={busy || !newName.trim()}
                  >
                    {pending === 'create' ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    {t('addMain')}
                  </Button>
                </div>
                {newError ? (
                  <p className="text-destructive text-xs">{newError}</p>
                ) : null}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {renderDialog()}
    </section>
  );

  function renderDialog() {
    if (!dialog) return null;
    if (dialog.kind === 'main') {
      const main = tree.mains.find((m) => m.id === dialog.id);
      if (!main) return null;
      return (
        <MainTagDialog
          key={main.id}
          tag={main}
          siblings={tree.mains}
          busy={busy}
          saving={pending === 'save'}
          onSave={(values) => update(main.id, values)}
          onDelete={() => askDelete(main)}
          onClose={closeDialog}
        />
      );
    }
    if (dialog.kind === 'sub') {
      const parent = tree.mains.find((m) => m.id === dialog.parentId);
      const sub = dialog.id
        ? (parent?.subs.find((s) => s.id === dialog.id) ?? null)
        : null;
      if (!parent || (dialog.id && !sub)) return null;
      return (
        <SubTagDialog
          key={dialog.id ?? `new:${parent.id}`}
          parent={parent}
          tag={sub}
          busy={busy}
          saving={pending === 'save'}
          moving={!!sub && pending === `move:${sub.id}`}
          onSave={(values) =>
            sub ? update(sub.id, values) : addSub(parent, values)
          }
          onMove={(dir) => sub && move(parent.subs, sub.id, dir)}
          onDelete={() => sub && askDelete(sub)}
          onClose={closeDialog}
        />
      );
    }
    const tag = tree.byId.get(dialog.id);
    if (!tag) return null;
    const subs =
      tag.parent_id === null
        ? (tree.mains.find((m) => m.id === tag.id)?.subs.length ?? 0)
        : 0;
    return (
      <DeleteChatTagDialog
        key={tag.id}
        tag={tag}
        subs={subs}
        count={dialog.count}
        busy={busy}
        deleting={pending === 'delete'}
        onConfirm={() => void remove(tag)}
        onClose={closeDialog}
      />
    );
  }
}
