'use client';

import { useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';

import {
  copyPageStyles,
  createPopoutHolder,
  POPOUT_SIZE_KEY,
  readPopoutSize,
  tileReporter,
} from '@/lib/meetings/float/popout';
import type { Size } from '@/lib/pbx/call-window';

import type { ActiveCall } from './meeting-session-provider';
import { MeetingPopout } from './meeting-popout';

interface DocumentPip {
  requestWindow: (size: Size) => Promise<Window>;
}

const MOUNT_ID = 'meeting-popout-root';
const COPIED_ATTRIBUTES = ['lang', 'dir', 'class', 'data-mode', 'data-theme'];

const documentPip = (): DocumentPip | null =>
  (window as unknown as { documentPictureInPicture?: DocumentPip })
    .documentPictureInPicture ?? null;

function storedSize(): Size {
  try {
    return readPopoutSize(window.localStorage.getItem(POPOUT_SIZE_KEY));
  } catch {
    return readPopoutSize(null);
  }
}

function prepareWindow(win: Window) {
  const doc = win.document;
  copyPageStyles(document, doc);
  for (const name of COPIED_ATTRIBUTES) {
    const value = document.documentElement.getAttribute(name);
    if (value !== null) doc.documentElement.setAttribute(name, value);
  }
  // Dark in both modes, like the in-app float.
  doc.documentElement.style.height = '100%';
  doc.body.className = document.body.className;
  doc.body.dataset.mode = 'dark';
  doc.body.style.height = '100%';
  doc.body.style.margin = '0';
  doc.body.style.overflow = 'hidden';
  const mount = doc.createElement('div');
  mount.id = MOUNT_ID;
  mount.style.height = '100%';
  doc.body.append(mount);
}

/**
 * The call in an always-on-top window, offered to the dock and the float
 * through `roomUi.popout`. The answer is the portal, for the layer to
 * render. Audio stays on the layer's <audio> elements in this window.
 */
export function useMeetingPopout(
  active: ActiveCall,
  inCall: boolean,
  onRoomPage: boolean
): ReactNode {
  const { engine, roomUi } = active;
  const t = useTranslations('MeetingSession.float');
  const [supported] = useState(() => documentPip() !== null);
  const [win, setWin] = useState<Window | null>(null);
  const [holder] = useState(() =>
    createPopoutHolder({
      request: () => documentPip()!.requestWindow(storedSize()),
      prepare: prepareWindow,
      onChange: setWin,
    })
  );

  const open = useCallback(() => {
    holder.open().catch(() => toast.error(t('popOutFailed')));
  }, [holder, t]);

  const value = useMemo(
    () => ({ supported, active: !!win, open, close: holder.close }),
    [supported, win, open, holder]
  );
  useEffect(() => {
    roomUi.setPopout(value);
    return () => roomUi.setPopout(null);
  }, [roomUi, value]);

  // An unmount covers the provider going; the deps a call swapped under
  // the same meeting; `inCall` a call ending with the layer still up.
  useEffect(() => {
    if (!inCall) return;
    return () => holder.close();
  }, [holder, engine, inCall]);

  // Chrome may open the window itself when the tab is hidden during a
  // call. Nothing depends on it, and with no click behind it a refusal
  // is nobody's to hear about.
  useEffect(() => {
    if (!supported || !inCall) return;
    const setHandler = (handler: (() => void) | null) => {
      try {
        navigator.mediaSession.setActionHandler(
          'enterpictureinpicture' as MediaSessionAction,
          handler
        );
      } catch {
        // An action name this browser does not know throws.
      }
    };
    setHandler(() => void holder.open().catch(() => {}));
    return () => setHandler(null);
  }, [supported, inCall, holder]);

  const mount = win?.document.getElementById(MOUNT_ID);
  return win && mount
    ? createPortal(
        <MeetingPopout
          active={active}
          win={win}
          reportSizes={tileReporter(onRoomPage, true) === 'popout'}
        />,
        mount
      )
    : null;
}
