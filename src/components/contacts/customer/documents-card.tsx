'use client';

// The customer page's Documents card (migration 178): the customer's
// reference number, their NAS folder and every document or photo they
// sent. GET /api/contacts/[id]/documents reads with the caller's RLS
// client, so whoever sees the page sees what they may. Owners and
// admins can put a file the NAS worker could not save back in its queue.

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Copy, ExternalLink, FileText, ImageIcon } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useCan } from '@/hooks/use-can';
import {
  DOCUMENTS_SHOWN_FIRST,
  documentStatusView,
  formatDocumentSize,
  nasFolderPath,
  parseDocumentsResponse,
  type CustomerDocFolderView,
  type CustomerDocumentView,
} from '@/lib/customer-docs/view';
import { cn } from '@/lib/utils';

import { SideCard } from './customer-cards';

const chip =
  'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium';

type Loaded = {
  folder: CustomerDocFolderView | null;
  documents: CustomerDocumentView[];
};

export function DocumentsCard({ contactId }: { contactId: string }) {
  const t = useTranslations('CustomerDocuments');
  const locale = useLocale();
  const canRetry = useCan('retry-customer-documents');
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    void fetch(`/api/contacts/${encodeURIComponent(contactId)}/documents`, {
      cache: 'no-store',
    })
      .then(async (r) => {
        if (!live) return;
        const parsed = r.ok
          ? parseDocumentsResponse(await r.json().catch(() => null))
          : null;
        if (!live) return;
        if (!parsed) return setFailed(true);
        setFailed(false);
        setData(parsed);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [contactId, reload]);

  const copyRef = useCallback(async (ref: string) => {
    try {
      await navigator.clipboard.writeText(ref);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused (insecure origin, no permission): nothing to undo.
    }
  }, []);

  const retry = useCallback(
    async (docId: string) => {
      setRetrying(docId);
      try {
        const r = await fetch(
          `/api/contacts/${encodeURIComponent(contactId)}/documents/${encodeURIComponent(docId)}/retry`,
          { method: 'POST' }
        );
        if (!r.ok) toast.error(t('retryFailed'));
      } catch {
        toast.error(t('retryFailed'));
      } finally {
        setRetrying(null);
        setReload((n) => n + 1);
      }
    },
    [contactId, t]
  );

  const when = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  };

  const docs = data?.documents ?? [];
  const shown = showAll ? docs : docs.slice(0, DOCUMENTS_SHOWN_FIRST);

  return (
    <SideCard title={t('title')}>
      {failed ? (
        <p className="text-muted-foreground text-sm">{t('loadFailed')}</p>
      ) : data === null ? (
        <div className="bg-muted h-10 animate-pulse rounded" aria-hidden />
      ) : (
        <div className="space-y-3">
          {data.folder ? (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="bg-card-2 border-border inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-xs font-semibold">
                  {data.folder.ref}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={copied ? t('copied') : t('copy')}
                  title={copied ? t('copied') : t('copy')}
                  onClick={() => void copyRef(data.folder!.ref)}
                >
                  {copied ? (
                    <Check className="text-success" />
                  ) : (
                    <Copy className="text-muted-foreground" />
                  )}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs break-all">
                {t('nasFolder', { path: nasFolderPath(data.folder.ref) })}
              </p>
              {!data.folder.onNas && (
                <p className="text-muted-foreground text-xs">
                  {t('nasPending')}
                </p>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">{t('noReference')}</p>
          )}

          {docs.length === 0 ? (
            data.folder && (
              <p className="text-muted-foreground text-sm">{t('empty')}</p>
            )
          ) : (
            <ul className="space-y-1">
              {shown.map((d) => {
                const Icon = d.kind === 'image' ? ImageIcon : FileText;
                const status = documentStatusView(d.status);
                const size = formatDocumentSize(d.sizeBytes);
                return (
                  <li
                    key={d.id}
                    className="-mx-2 flex items-start gap-2 rounded-md px-2 py-1.5 text-sm"
                  >
                    <Icon
                      className="text-muted-foreground mt-0.5 size-4 shrink-0"
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="truncate font-medium">
                        {d.name ??
                          (d.kind === 'image'
                            ? t('fallbackPhoto')
                            : t('fallbackDocument'))}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {when(d.receivedAt)}
                        {size ? ` · ${size}` : ''}
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={cn(chip, status.tone)}>
                          {t(`status.${status.key}`)}
                        </span>
                        {d.status === 'failed' && canRetry && (
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={retrying === d.id}
                            onClick={() => void retry(d.id)}
                          >
                            {t('retry')}
                          </Button>
                        )}
                        {d.url && (
                          <a
                            href={d.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary inline-flex items-center gap-1 text-xs hover:underline"
                          >
                            <ExternalLink className="size-3" aria-hidden />
                            {t('open')}
                          </a>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {docs.length > DOCUMENTS_SHOWN_FIRST && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? t('showFewer') : t('showAll', { count: docs.length })}
            </Button>
          )}
        </div>
      )}
    </SideCard>
  );
}
