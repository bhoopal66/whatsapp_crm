'use client';

import { Maximize2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { floatTileSizes } from '@/lib/meetings/float/focus';
import { POPOUT_SIZE_KEY, writePopoutSize } from '@/lib/meetings/float/popout';

import { FloatButton, FloatControls } from './float-controls';
import { FloatStage } from './float-stage';
import type { ActiveCall } from './meeting-session-provider';
import { useFloatView } from './use-float-view';

/** The controls' row, and the gap above the stage. */
const CHROME_HEIGHT = 48 + 6;
/** The Return button's share of the row, out of what the controls may use. */
const RETURN_WIDTH = 40;

const nameWindow = (win: Window, title: string) => {
  win.document.title = title;
};

/** The call, in a window of its own. Rendered through a portal into it. */
export function MeetingPopout({
  active,
  win,
  reportSizes,
}: {
  active: ActiveCall;
  win: Window;
  reportSizes: boolean;
}) {
  const { call } = active;
  const t = useTranslations('MeetingSession.float');
  const {
    self,
    ids,
    focus,
    people,
    view,
    setView,
    openRoom,
    openChat,
    unread,
  } = useFloatView(active);
  const [box, setBox] = useState({
    width: win.innerWidth,
    height: win.innerHeight,
  });

  useEffect(() => {
    const onResize = () => {
      const size = { width: win.innerWidth, height: win.innerHeight };
      setBox(size);
      try {
        window.localStorage.setItem(POPOUT_SIZE_KEY, writePopoutSize(size));
      } catch {
        // Blocked storage: the window just forgets its size.
      }
    };
    win.addEventListener('resize', onResize);
    return () => win.removeEventListener('resize', onResize);
  }, [win]);

  const title = call.meeting?.title ?? '';
  useEffect(() => {
    nameWindow(win, title);
  }, [win, title]);

  const { setTileSizes } = call;
  const stageHeight = box.height - CHROME_HEIGHT;
  const mainCameraId = focus.kind === 'camera' ? focus.mainId : null;
  useEffect(() => {
    if (!reportSizes) return;
    setTileSizes(
      floatTileSizes({
        participantIds: ids,
        selfId: self,
        mainCameraId,
        stageHeight,
        dpr: win.devicePixelRatio,
        minimized: false,
      })
    );
  }, [reportSizes, ids, self, mainCameraId, stageHeight, win, setTileSizes]);

  // `window` is the app's here: this code runs there, whatever it draws in.
  const backToApp = (go: () => void) => {
    window.focus();
    go();
  };

  return (
    <div
      data-meeting-popout
      role="region"
      aria-label={t('region')}
      className="bg-card text-foreground flex h-full flex-col select-none"
    >
      <div className="flex min-h-0 flex-1 px-1.5 pt-1.5">
        <FloatStage
          call={call}
          focus={focus}
          people={people}
          view={view}
          onView={setView}
          width={box.width}
          height={stageHeight}
        />
      </div>
      <div className="flex shrink-0 items-center ps-2.5">
        <FloatButton label={t('return')} onClick={() => backToApp(openRoom)}>
          <Maximize2 className="size-4" />
        </FloatButton>
        <div className="min-w-0 flex-1">
          <FloatControls
            call={call}
            width={box.width - RETURN_WIDTH}
            chatUnread={unread}
            onChat={() => backToApp(openChat)}
          />
        </div>
      </div>
    </div>
  );
}
