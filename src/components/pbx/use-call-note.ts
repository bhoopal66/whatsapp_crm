'use client';

// The in-call panel's draft (call-note-store): taken back from the
// session cache when one was kept for this call, and kept there, behind
// a message with a way back, when the panel goes with something unsaved
// (its own close, a live call taking the panel, anything else that
// unmounts it).

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  createCallNote,
  dropKeptCallNote,
  keepCallNote,
  keptCallNote,
} from '@/lib/pbx/call-note-store';
import type { PanelCall } from '@/lib/pbx/call-ui';
import { sessionKey } from '@/lib/session-cache';

export function useCallNote(
  accountId: string | null,
  panel: PanelCall,
  calls: {
    userId: string | null;
    reopenPanel: (panel: PanelCall) => boolean;
  }
) {
  const t = useTranslations('PbxCall');
  const { userId, reopenPanel } = calls;
  // For the panel's lifetime: it is keyed by its call.
  const [key] = useState(() =>
    sessionKey(accountId, userId, `call-note:${panel.key}`)
  );
  const [note] = useState(() => createCallNote(keptCallNote(key) ?? undefined));
  const draft = useSyncExternalStore(note.subscribe, note.get, note.get);
  // Something was saved here, so an untouched panel does not say so.
  const [saved, setSaved] = useState(false);
  if (draft.saving && !saved) setSaved(true);

  const how = useRef<'open' | 'tried' | 'discard'>('open');
  const keep = useEffectEvent(() => {
    if (how.current === 'discard') return;
    const id = `call-note:${panel.key}`;
    void keepCallNote(key, note, {
      tried: how.current === 'tried',
      // Names nobody: it stays on screen through other calls and pages.
      show: () =>
        toast.warning(t('noteKept'), {
          id,
          duration: Infinity,
          dismissible: false,
          action: {
            label: t('noteKeptOpen'),
            onClick: (e) => {
              // The panel takes the draft, and with it this message.
              e.preventDefault();
              if (!reopenPanel(panel)) toast.info(t('noteKeptBusy'));
            },
          },
        }),
      hide: () => toast.dismiss(id),
    });
  });
  useEffect(() => {
    dropKeptCallNote(key);
    return () => keep();
  }, [key]);

  /** How the panel is about to go: its save just failed, or no matter. */
  const leaving = useCallback((as: 'tried' | 'discard') => {
    how.current = as;
  }, []);
  return { note, draft, saved, leaving };
}
