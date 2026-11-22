'use client';

// The inbox contact panel's Documents row (migration 178): the
// customer's reference number and document count, linking to the
// customer page's Documents card. Shown only once a folder exists;
// an error shows nothing.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { FolderOpen } from 'lucide-react';

import {
  parseDocumentsSummary,
  type CustomerDocFolderView,
} from '@/lib/customer-docs/view';

type Summary = {
  contactId: string;
  folder: CustomerDocFolderView;
  count: number;
};

export function ContactDocumentsRow({ contactId }: { contactId: string }) {
  const t = useTranslations('CustomerDocuments');
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(
      `/api/contacts/${encodeURIComponent(contactId)}/documents?summary=1`,
      { cache: 'no-store' }
    )
      .then(async (r) => {
        const parsed = r.ok
          ? parseDocumentsSummary(await r.json().catch(() => null))
          : null;
        // A response for a contact the panel has since left is dropped.
        if (!live) return;
        setSummary(
          parsed?.folder
            ? { contactId, folder: parsed.folder, count: parsed.count }
            : null
        );
      })
      .catch(() => live && setSummary(null));
    return () => {
      live = false;
    };
  }, [contactId]);

  // Until this contact's answer is in, the previous contact's row stays hidden.
  if (!summary || summary.contactId !== contactId) return null;

  return (
    <Link
      href={`/contacts/${contactId}`}
      title={t('sidebarLink')}
      className="text-wa-text hover:bg-wa-row-hover flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors"
    >
      <FolderOpen className="text-wa-icon h-4 w-4 shrink-0" />
      <span className="shrink-0">{t('sidebarLabel')}</span>
      <span className="bg-wa-search min-w-0 truncate rounded-md px-1.5 py-0.5 font-mono text-xs font-semibold">
        {summary.folder.ref}
      </span>
      <span className="text-wa-text-secondary ms-auto shrink-0 text-xs">
        {t('sidebarCount', { count: summary.count })}
      </span>
    </Link>
  );
}
