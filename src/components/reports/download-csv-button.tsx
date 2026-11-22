'use client';

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useCan } from '@/hooks/use-can';
import { downloadCsv } from '@/lib/csv/download';

export interface CsvExportOption {
  /** Shown in the menu when there is more than one file. */
  label: string;
  url: string;
}

interface DownloadCsvButtonProps {
  /** One file: a plain button. Several: a button opening a menu. */
  options: readonly CsvExportOption[];
  size?: 'sm' | 'default';
  disabled?: boolean;
}

/**
 * "Download CSV" for a report screen. Shown to the owner only
 * (`canExportReports`); the export routes refuse everyone else on the
 * server, so this only hides the button.
 */
export function DownloadCsvButton({
  options,
  size = 'default',
  disabled = false,
}: DownloadCsvButtonProps) {
  const t = useTranslations('ReportExports');
  const allowed = useCan('export-reports');
  const [busy, setBusy] = useState(false);

  if (!allowed || options.length === 0) return null;

  const run = async (url: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await downloadCsv(url);
    } catch {
      toast.error(t('failed'));
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <>
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <Download className="h-4 w-4" aria-hidden />
      )}
      {busy ? t('downloading') : t('download')}
    </>
  );

  if (options.length === 1) {
    return (
      <Button
        type="button"
        variant="outline"
        size={size}
        disabled={disabled || busy}
        onClick={() => void run(options[0].url)}
      >
        {content}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled || busy}
        render={<Button type="button" variant="outline" size={size} />}
      >
        {content}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((o) => (
          <DropdownMenuItem key={o.url} onClick={() => void run(o.url)}>
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
