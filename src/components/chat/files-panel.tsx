'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CornerDownRight, Download, X } from 'lucide-react';

import {
  channelFiles,
  signedFileUrl,
  type ChannelFile,
  type ChatMessage,
} from '@/lib/chat';
import {
  appendPage,
  FILE_TABS,
  isCurrentFilesRequest,
  nextFilesRequest,
  pageCut,
  tabKind,
  type FilesRequest,
  type FileTab,
} from '@/lib/chat/files';
import { attachmentDisplay } from '@/lib/chat/voice';
import { downloadUrlAs } from '@/lib/media/download';
import { cn } from '@/lib/utils';

import { ChatFileChip, ChatImageThumb, ChatVideo } from './attachment-views';
import { useChatWorkspaceContext } from './chat-context';
import { ImageLightbox } from './image-lightbox';
import { ChatVoiceNote } from './voice-note';

const PAGE = 40;

export interface FilesPanelProps {
  channelId: string;
  onClose: () => void;
  /** Bring the file's message into view (a reply opens its thread). */
  onJump: (message: Pick<ChatMessage, 'id' | 'threadRootId'>) => void;
}

interface TabState {
  items: ChannelFile[];
  before: string | null;
  loading: boolean;
}

/**
 * The right column (a full-screen sheet below lg): the channel's files,
 * newest first, by kind, from channelFiles (RLS decides, live messages
 * only). Each tab pages with `before`; images are a grid that opens the
 * viewer across the tab's loaded images.
 */
export function FilesPanel({ channelId, onClose, onJump }: FilesPanelProps) {
  const t = useTranslations('Chat.files');
  const locale = useLocale();
  const { sb, fail, peopleById } = useChatWorkspaceContext();
  const [tab, setTab] = useState<FileTab>('all');
  const [state, setState] = useState<TabState | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  // The list on screen; a page asked for under another one is dropped.
  const current = useRef<FilesRequest>({ tab: 'all', gen: 0 });

  const load = useCallback(
    (which: FileTab, before: string | null, prev: ChannelFile[]) => {
      return channelFiles(sb, {
        channelId,
        kind: tabKind(which),
        before,
        limit: PAGE,
      }).then(({ items, hasMore }) => {
        const cut = pageCut(items, hasMore);
        return {
          items: appendPage(prev, cut.keep),
          before: cut.before,
          loading: false,
        };
      });
    },
    [sb, channelId]
  );

  useEffect(() => {
    let off = false;
    const req = nextFilesRequest(current.current, tab);
    current.current = req;
    const stale = () => off || !isCurrentFilesRequest(req, current.current);
    load(tab, null, [])
      .then((s) => !stale() && setState(s))
      .catch((err) => {
        if (stale()) return;
        setState({ items: [], before: null, loading: false });
        fail(err);
      });
    return () => {
      off = true;
    };
  }, [load, tab, fail]);

  const more = () => {
    if (!state?.before || state.loading) return;
    const prev = state.items;
    const req = current.current;
    const stale = () => !isCurrentFilesRequest(req, current.current);
    setState({ ...state, loading: true });
    load(tab, state.before, prev)
      .then((s) => !stale() && setState(s))
      .catch((err) => {
        if (stale()) return;
        setState((s) => s && { ...s, loading: false });
        fail(err);
      });
  };

  const items = state?.items ?? [];
  const images = items.filter((f) => attachmentDisplay(f) === 'image');
  const openImage = (f: ChannelFile) =>
    setViewing(images.findIndex((i) => i.id === f.id));

  const when = (ts: string) => {
    const d = new Date(ts.replace(' ', 'T'));
    return Number.isNaN(d.getTime())
      ? ''
      : new Intl.DateTimeFormat(locale, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }).format(d);
  };
  const sender = (f: ChannelFile) =>
    (f.authorId && peopleById.get(f.authorId.toLowerCase())?.fullName) ||
    t('unknownSender');
  const download = (f: ChannelFile) =>
    signedFileUrl(sb, f.storagePath)
      .then((url) => downloadUrlAs(url, f.name))
      .catch(() => {});
  const jump = (f: ChannelFile) =>
    onJump({ id: f.messageId, threadRootId: f.threadRootId });

  const tools = (f: ChannelFile) => (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => jump(f)}
        className="text-primary hover:bg-muted flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium"
      >
        <CornerDownRight className="size-3.5" aria-hidden />
        {t('jump')}
      </button>
      <button
        type="button"
        onClick={() => void download(f)}
        aria-label={t('downloadName', { name: f.name })}
        title={t('download')}
        className="hover:bg-muted text-muted-foreground flex size-6 items-center justify-center rounded"
      >
        <Download className="size-3.5" aria-hidden />
      </button>
    </div>
  );

  const meta = (f: ChannelFile) => (
    <p className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
      <span className="text-foreground font-semibold">{sender(f)}</span>
      {' · '}
      {when(f.createdAt)}
      {f.threadRootId && ` · ${t('inThread')}`}
    </p>
  );

  const content = (f: ChannelFile) => {
    const display = attachmentDisplay(f);
    if (display === 'voice' || display === 'audio')
      return (
        <ChatVoiceNote
          attachment={f}
          messageId={f.messageId}
          authorId={f.authorId}
          file={display === 'audio'}
        />
      );
    if (display === 'image')
      return <ChatImageThumb a={f} onOpen={() => openImage(f)} />;
    if (display === 'video') return <ChatVideo a={f} />;
    return <ChatFileChip a={f} />;
  };

  const grid = tab === 'image';
  return (
    <aside
      aria-label={t('title')}
      className="bg-background fixed inset-0 z-40 flex min-h-0 flex-col lg:static lg:z-auto lg:w-[360px] lg:shrink-0 lg:border-l"
    >
      <header className="border-b px-4 pt-3">
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 text-base font-bold">{t('title')}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="hover:bg-muted -mr-1 rounded p-1"
          >
            <X className="size-4" />
          </button>
        </div>
        <div role="tablist" className="mt-2 -mb-px flex gap-1 overflow-x-auto">
          {FILE_TABS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => {
                if (k === tab) return;
                // A new tab starts from its first page, viewer closed.
                setViewing(null);
                setState(null);
                current.current = nextFilesRequest(current.current, k);
                setTab(k);
              }}
              className={cn(
                'shrink-0 border-b-2 px-2 pb-2 text-sm',
                tab === k
                  ? 'border-primary text-primary font-semibold'
                  : 'text-muted-foreground hover:text-foreground border-transparent'
              )}
            >
              {t(`tab.${k}`)}
            </button>
          ))}
        </div>
      </header>
      <div data-inbox-scroll-root className="min-h-0 flex-1 overflow-y-auto">
        {state === null || (state.loading && items.length === 0) ? (
          <p className="text-muted-foreground p-6 text-center text-sm">
            {t('loading')}
          </p>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground p-6 text-center text-sm">
            {t(`empty.${tab}`)}
          </p>
        ) : grid ? (
          <ul className="grid grid-cols-3 gap-1.5 p-3">
            {items.map((f) => (
              <li
                key={f.id}
                title={`${sender(f)} · ${when(f.createdAt)}`}
                className="group relative aspect-square"
              >
                <ChatImageThumb
                  a={f}
                  onOpen={() => openImage(f)}
                  className="size-full max-w-none [&_img]:size-full [&_img]:max-h-none [&_img]:max-w-none"
                />
                <button
                  type="button"
                  onClick={() => jump(f)}
                  aria-label={t('jump')}
                  title={t('jump')}
                  className="bg-card/90 absolute right-1 bottom-1 flex size-6 items-center justify-center rounded border opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                >
                  <CornerDownRight className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="divide-y">
            {items.map((f) => (
              <li key={f.id} className="space-y-1.5 px-4 py-3">
                <div className="flex items-center gap-2">
                  {meta(f)}
                  {tools(f)}
                </div>
                {content(f)}
              </li>
            ))}
          </ul>
        )}
        {state?.before && (
          <div className="p-3 text-center">
            <button
              type="button"
              onClick={more}
              disabled={state.loading}
              className="hover:bg-muted rounded-full border px-3 py-1 text-xs font-medium disabled:opacity-50"
            >
              {state.loading ? t('loading') : t('loadMore')}
            </button>
          </div>
        )}
      </div>
      <ImageLightbox
        images={images}
        index={viewing}
        onIndex={setViewing}
        onClose={() => setViewing(null)}
      />
    </aside>
  );
}
