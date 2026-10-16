'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import listPlugin from '@fullcalendar/list';
import multiMonthPlugin from '@fullcalendar/multimonth';
import koLocale from '@fullcalendar/core/locales/ko';
import type {
  DatesSetArg,
  DayHeaderContentArg,
  EventApi,
  EventContentArg,
  EventDropArg,
  EventInput,
  EventSourceFuncArg,
  NowIndicatorContentArg,
} from '@fullcalendar/core';
import type { EventResizeDoneArg } from '@fullcalendar/interaction';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  PanelLeft,
  Plus,
  Repeat,
  Search,
  SquareCheck,
  Users,
  Video,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { MeetingFormDialog } from '@/components/meetings/meeting-form-dialog';
import { useMeetingTimeZone } from '@/components/meetings/use-workspace-members';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import type { FeedItem } from '@/lib/calendar/feed';
import {
  calendarTimeZone,
  intlTimeZonePlugin,
  wallDateKey,
} from '@/lib/calendar/fc-timezone';
import {
  datesKey,
  gridScrollTime,
  shouldScrollToNow,
} from '@/lib/calendar/grid-scroll';
import { colorVar, paletteCss } from '@/lib/calendar/ui/colors';
import {
  chipDetails,
  chipLayout,
  type ChipLayout,
} from '@/lib/calendar/ui/event-chip';
import {
  feedItemsToEventInputs,
  isItemHidden,
  type CalendarEventProps,
} from '@/lib/calendar/ui/event-input';
import {
  FeedCache,
  feedUrl,
  parseFeedResponse,
} from '@/lib/calendar/ui/feed-cache';
import { itemKey, itemStartMs } from '@/lib/calendar/ui/item-time';
import { isEditableTarget, keyAction } from '@/lib/calendar/ui/keyboard';
import {
  DEFAULT_LAYERS,
  LAYER_COLORS,
  LAYER_KEYS,
  filterByLayers,
  layersStorageKey,
  parseLayers,
  serialiseLayers,
  type LayerKey,
  type Layers,
} from '@/lib/calendar/ui/layers';
import { addMonths, markedDays, monthGrid } from '@/lib/calendar/ui/mini-month';
import {
  itemMatches,
  nextMatch,
  searchMatches,
} from '@/lib/calendar/ui/search';
import { upcomingItems } from '@/lib/calendar/ui/upcoming';
import {
  FC_VIEWS,
  VIEW_KEYS,
  serialiseCalendarParams,
  viewKeyOf,
  type ViewKey,
} from '@/lib/calendar/ui/url-state';

/**
 * The seams the event popover, the create/edit dialog and drag/resize
 * persistence plug into. Every one is optional and a no-op until then.
 */
export interface CalendarViewProps {
  initialDate?: string | null;
  initialView?: ViewKey;
  /** `?event=<id>`: opened through onEventClick once loaded. */
  initialEventId?: string | null;
  /** A drag-select on empty time (FullCalendar instants; end exclusive). */
  onSelectRange?: (start: Date, end: Date, allDay: boolean) => void;
  onEventClick?: (item: FeedItem, anchorEl: HTMLElement) => void;
  /** A drag or resize; call `revert` if the save fails. */
  onEventChange?: (
    item: FeedItem,
    newStart: Date,
    newEnd: Date | null,
    revert: () => void
  ) => void;
  /** Create → Event, and the N shortcut. */
  onCreate?: () => void;
  /** Change it to drop the cache and refetch (e.g. after a save). */
  refreshSignal?: number;
}

const noop = () => {};
const SCOPE = '.cal-root';
const REALTIME_DEBOUNCE_MS = 500;
const RAIL_KEY = 'calendar.rail.v1';

/**
 * Module-level so its identity is stable: FullCalendar memoises its
 * DateEnv on the locales array, and a fresh one per render rebuilt the
 * date profile (and re-fired datesSet) on every render.
 */
const FC_LOCALES = [koLocale];

const EVENT_TIME_FORMAT = {
  hour: 'numeric',
  minute: '2-digit',
  omitZeroMinute: true,
  meridiem: 'short',
} as const;

const itemOf = (event: EventApi): FeedItem =>
  (event.extendedProps as CalendarEventProps).item;

const CALENDAR_CSS = `${paletteCss(SCOPE)}
${SCOPE} .fc {
  --fc-border-color: color-mix(in oklab, var(--border) 80%, transparent);
  --fc-page-bg-color: var(--card);
  --fc-neutral-bg-color: var(--muted);
  --fc-today-bg-color: color-mix(in oklab, var(--primary) 6%, transparent);
  --fc-now-indicator-color: var(--destructive);
  --fc-list-event-hover-bg-color: var(--muted);
  --fc-highlight-color: color-mix(in oklab, var(--primary) 14%, transparent);
  --fc-non-business-color: color-mix(in oklab, var(--muted) 40%, transparent);
  font-size: 0.8125rem;
  color: var(--foreground);
}
${SCOPE} .fc a { color: inherit; text-decoration: none; }
${SCOPE} .fc .fc-scrollgrid { border-radius: 0.5rem; overflow: hidden; }
${SCOPE} .fc .fc-col-header-cell { vertical-align: middle; }
${SCOPE} .fc .fc-col-header-cell-cushion { color: var(--muted-foreground); font-weight: 500; padding: 6px 4px; }
${SCOPE} .fc .cal-dh { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px 0 6px; }
${SCOPE} .fc .cal-dh__wd { font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted-foreground); }
${SCOPE} .fc .cal-dh__num { display: flex; align-items: center; justify-content: center; min-width: 2rem; height: 2rem; padding: 0 6px; border-radius: 9999px; font-size: 1.25rem; font-weight: 500; line-height: 1; color: var(--foreground); }
${SCOPE} .fc .cal-dh--today .cal-dh__wd { color: var(--primary); }
${SCOPE} .fc .cal-dh--today .cal-dh__num { background: var(--primary); color: var(--primary-foreground); font-weight: 600; }
${SCOPE} .fc .cal-dh--past .cal-dh__num { color: var(--muted-foreground); }
${SCOPE} .fc .fc-daygrid-day.fc-day-sat, ${SCOPE} .fc .fc-daygrid-day.fc-day-sun { background: color-mix(in oklab, var(--muted) 35%, transparent); }
${SCOPE} .fc .fc-daygrid-day-number { color: var(--muted-foreground); font-weight: 500; }
${SCOPE} .fc .fc-day-today .fc-daygrid-day-number { background: var(--primary); color: var(--primary-foreground); border-radius: 9999px; min-width: 1.5rem; text-align: center; margin: 2px; padding: 2px 6px; }
${SCOPE} .fc .fc-timegrid-slot { height: 2.5rem; }
${SCOPE} .fc .fc-timegrid-slot-label { vertical-align: top; border-color: transparent; }
${SCOPE} .fc .fc-timegrid-slot-label-cushion { color: var(--muted-foreground); font-size: 0.6875rem; font-weight: 500; white-space: nowrap; padding: 0 8px 0 4px; transform: translateY(-50%); }
${SCOPE} .fc .fc-timegrid-slot-label-frame { text-align: right; }
${SCOPE} .fc .fc-timegrid-axis-cushion { color: var(--muted-foreground); font-size: 0.6875rem; font-weight: 600; }
${SCOPE} .fc .fc-timegrid-now-indicator-line { border-width: 2px 0 0; }
${SCOPE} .fc .fc-timegrid-now-indicator-line::before { content: ''; position: absolute; left: -5px; top: -6px; width: 10px; height: 10px; border-radius: 9999px; background: var(--fc-now-indicator-color); }
${SCOPE} .fc .fc-timegrid-now-indicator-arrow { border: 0; margin-top: -0.55rem; left: 2px; right: auto; z-index: 5; }
${SCOPE} .fc .cal-now { display: inline-block; border-radius: 9999px; padding: 1px 5px; background: var(--fc-now-indicator-color); color: white; font-size: 0.625rem; font-weight: 600; line-height: 0.9rem; white-space: nowrap; }
${SCOPE} .fc .fc-timegrid-event-harness-inset .fc-timegrid-event { box-shadow: 0 0 0 1px var(--card); }
${SCOPE} .fc .cal-ev { border-radius: 6px; border-width: 0 0 0 3px; border-style: solid; cursor: pointer; transition: box-shadow 0.15s, filter 0.15s; }
${SCOPE} .fc .fc-daygrid-event.cal-ev { margin-top: 2px; }
${SCOPE} .fc .cal-ev:hover { filter: brightness(0.97); box-shadow: 0 2px 6px rgb(0 0 0 / 0.16); }
${SCOPE} .fc .fc-list-event.cal-ev { border-width: 0; }
${SCOPE} .fc .fc-list-event-time { color: var(--muted-foreground); white-space: nowrap; }
${SCOPE} .fc .fc-list-day-cushion { background: var(--muted); }
${SCOPE} .fc .cal-ev--pending { border-width: 1px 1px 1px 3px; border-style: dashed; }
${SCOPE} .fc .cal-ev--declined { opacity: 0.55; }
${SCOPE} .fc .cal-ev--declined .cal-chip__name { text-decoration: line-through; }
${SCOPE} .fc .cal-ev--tentative { background-image: repeating-linear-gradient(135deg, transparent 0 6px, color-mix(in oklab, var(--card) 45%, transparent) 6px 12px); }
${SCOPE} .fc .cal-ev--match { box-shadow: 0 0 0 2px var(--primary); }
${SCOPE} .fc .cal-chip { display: flex; min-width: 0; overflow: hidden; color: var(--foreground); line-height: 1.15rem; }
${SCOPE} .fc .cal-chip svg { flex-shrink: 0; width: 0.75rem; height: 0.75rem; }
${SCOPE} .fc .cal-chip__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
${SCOPE} .fc .cal-chip__time { flex-shrink: 0; white-space: nowrap; font-variant-numeric: tabular-nums; color: color-mix(in oklab, var(--foreground) 72%, transparent); font-weight: 500; }
${SCOPE} .fc .cal-chip__line { display: flex; align-items: center; gap: 4px; min-width: 0; }
${SCOPE} .fc .cal-chip__meta { display: flex; align-items: center; gap: 4px; min-width: 0; font-size: 0.6875rem; color: color-mix(in oklab, var(--foreground) 65%, transparent); }
${SCOPE} .fc .cal-chip__meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
${SCOPE} .fc .cal-chip--full { flex-direction: column; gap: 1px; height: 100%; padding: 2px 5px; font-size: 0.75rem; line-height: 1rem; }
${SCOPE} .fc .cal-chip--full .cal-chip__name { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
${SCOPE} .fc .cal-chip--full .cal-chip__time { flex-shrink: 1; white-space: normal; font-size: 0.6875rem; line-height: 0.875rem; }
${SCOPE} .fc .cal-chip--compact { align-items: flex-start; gap: 4px; padding: 1px 5px 0; font-size: 0.6875rem; line-height: 1rem; height: 100%; }
${SCOPE} .fc .cal-chip--compact svg { margin-top: 2px; }
${SCOPE} .fc .cal-chip--compact .cal-chip__name { flex-shrink: 0; max-width: 100%; }
${SCOPE} .fc .cal-chip--compact .cal-chip__time { flex-shrink: 1; min-width: 0; overflow: hidden; }
${SCOPE} .fc .cal-chip--row, ${SCOPE} .fc .cal-chip--bar { align-items: center; gap: 4px; padding: 1px 5px; font-size: 0.75rem; }
${SCOPE} .fc .cal-chip--row .cal-chip__name { font-weight: 500; }
${SCOPE} .fc .cal-chip--list { align-items: center; gap: 8px; }
${SCOPE} .fc .cal-chip--list .cal-chip__name { font-weight: 500; }
`;

export function CalendarView({
  initialDate = null,
  initialView = 'week',
  initialEventId = null,
  onSelectRange = noop,
  onEventClick = noop,
  onEventChange = noop,
  onCreate = noop,
  refreshSignal,
}: CalendarViewProps) {
  const t = useTranslations('Calendar');
  const locale = useLocale();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  // Agents and viewers attend; team leaders and up create (111).
  const canCreateMeeting = useCan('create-meetings');

  const accountZone = useMeetingTimeZone();
  const fcZone = calendarTimeZone(accountZone);
  const zone =
    fcZone === 'local'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : fcZone;

  const calRef = useRef<FullCalendar>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const cacheRef = useRef(new FeedCache());
  const abortRef = useRef<AbortController | null>(null);
  const pendingEventRef = useRef<string | null>(initialEventId);
  const callbacks = useRef({
    onSelectRange,
    onEventClick,
    onEventChange,
    onCreate,
  });
  useEffect(() => {
    callbacks.current = {
      onSelectRange,
      onEventClick,
      onEventChange,
      onCreate,
    };
  });

  const [items, setItems] = useState<FeedItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [view, setView] = useState<ViewKey>(initialView);
  const [cursor, setCursor] = useState<string | null>(initialDate);
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS);
  const layersRef = useRef(layers);
  const [query, setQuery] = useState('');
  const [currentMatch, setCurrentMatch] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [meetingOpen, setMeetingOpen] = useState(false);
  const [meetingKey, setMeetingKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const api = useCallback(() => calRef.current?.getApi() ?? null, []);
  const refetch = useCallback(
    (dropCache: boolean) => {
      if (dropCache) cacheRef.current.clear();
      api()?.refetchEvents();
    },
    [api]
  );

  // Per-viewer layers and the rail's state, read once the viewer is known.
  useEffect(() => {
    if (!userId) return;
    try {
      const saved = parseLayers(localStorage.getItem(layersStorageKey(userId)));
      layersRef.current = saved;
      setLayers(saved);
      setRailOpen(localStorage.getItem(RAIL_KEY) !== 'closed');
    } catch {
      // Storage unavailable: defaults stand.
    }
    api()?.refetchEvents();
  }, [userId, api]);

  const toggleLayer = (key: LayerKey) => {
    const next = { ...layersRef.current, [key]: !layersRef.current[key] };
    layersRef.current = next;
    setLayers(next);
    try {
      if (userId)
        localStorage.setItem(layersStorageKey(userId), serialiseLayers(next));
    } catch {
      // Not persisted; the toggle still applies.
    }
    refetch(false);
  };

  const toggleRail = () => {
    setRailOpen((open) => {
      try {
        localStorage.setItem(RAIL_KEY, open ? 'closed' : 'open');
      } catch {
        // Not persisted.
      }
      return !open;
    });
  };

  const fetchEvents = useCallback(
    (
      info: EventSourceFuncArg,
      success: (events: EventInput[]) => void,
      failure: (error: Error) => void
    ) => {
      const url = feedUrl(
        info.start.toISOString(),
        info.end.toISOString(),
        layersRef.current.workspaceMeetings
      );
      const deliver = (loaded: FeedItem[]) => {
        setItems(loaded);
        success(
          feedItemsToEventInputs(filterByLayers(loaded, layersRef.current))
        );
      };
      const hit = cacheRef.current.get(url);
      if (hit) {
        deliver(hit);
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      fetch(url, { signal: controller.signal })
        .then(async (res) => {
          const body: unknown = await res.json().catch(() => null);
          if (!res.ok) {
            const message = (body as { error?: unknown } | null)?.error;
            throw new Error(
              typeof message === 'string' ? message : `HTTP ${res.status}`
            );
          }
          return parseFeedResponse(body);
        })
        .then((loaded) => {
          cacheRef.current.set(url, loaded);
          setLoadError(null);
          deliver(loaded);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          const error = err instanceof Error ? err : new Error(String(err));
          setLoadError(error.message);
          failure(error);
        });
    },
    []
  );

  // Refetch on focus (the 30 s cache still applies) and on realtime
  // changes (which drop the cache), debounced.
  useEffect(() => {
    const onFocus = () => refetch(false);
    window.addEventListener('focus', onFocus);
    const tick = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(tick);
    };
  }, [refetch]);

  useEffect(() => {
    if (!userId) return;
    const supabase = createClient();
    let timer: number | undefined;
    const bump = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => refetch(true), REALTIME_DEBOUNCE_MS);
    };
    let channel = supabase.channel(`calendar-${userId}`);
    for (const table of [
      'calendar_events',
      'calendar_event_attendees',
      'meetings',
    ]) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        bump
      );
    }
    channel.subscribe();
    return () => {
      window.clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [userId, refetch]);

  const firstSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === firstSignal.current) return;
    firstSignal.current = refreshSignal;
    refetch(true);
  }, [refreshSignal, refetch]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const visibleItems = useMemo(
    () => filterByLayers(items, layers).filter((i) => !isItemHidden(i)),
    [items, layers]
  );
  const matches = useMemo(
    () => searchMatches(visibleItems, query, zone),
    [visibleItems, query, zone]
  );
  const marked = useMemo(
    () => markedDays(visibleItems, zone),
    [visibleItems, zone]
  );
  const upcoming = useMemo(
    () => upcomingItems(visibleItems, now, zone),
    [visibleItems, now, zone]
  );

  const syncUrl = useCallback((date: string | null, v: ViewKey) => {
    const qs = serialiseCalendarParams(window.location.search.slice(1), {
      date,
      view: v,
      eventId: pendingEventRef.current,
    });
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}?${qs}`
    );
  }, []);

  // The dates last scrolled to "now"; see lib/calendar/grid-scroll.ts.
  const scrolledDatesRef = useRef<string | null>(null);

  const onDatesSet = (arg: DatesSetArg) => {
    const key = datesKey(arg.view.type, arg.startStr, arg.endStr);
    if (shouldScrollToNow(scrolledDatesRef.current, key)) {
      scrolledDatesRef.current = key;
      arg.view.calendar.scrollToTime(gridScrollTime(zone, Date.now()));
    }
    const v = viewKeyOf(arg.view.type) ?? 'week';
    const date = wallDateKey(zone, arg.view.calendar.getDate().getTime());
    setTitle(arg.view.title);
    setView(v);
    setCursor(date);
    syncUrl(date, v);
  };

  // `?event=<id>`: open it once it has loaded, then drop the parameter.
  useEffect(() => {
    const wanted = pendingEventRef.current;
    if (!wanted) return;
    const item = items.find((i) => i.id === wanted);
    if (!item) return;
    pendingEventRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      const el =
        rootRef.current?.querySelector<HTMLElement>(
          `[data-item-key="${CSS.escape(itemKey(item))}"]`
        ) ?? rootRef.current;
      if (el) callbacks.current.onEventClick(item, el);
      if (cursor) syncUrl(cursor, view);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [items, cursor, view, syncUrl]);

  const goView = useCallback(
    (v: ViewKey) => api()?.changeView(FC_VIEWS[v]),
    [api]
  );

  const jumpToNextMatch = () => {
    const cal = api();
    if (!cal) return;
    const match = nextMatch(
      matches,
      currentMatch,
      cal.getDate().getTime(),
      zone
    );
    if (!match) return;
    setCurrentMatch(itemKey(match));
    cal.gotoDate(match.start);
  };

  const clearSearch = () => {
    setQuery('');
    setCurrentMatch(null);
  };

  const openMeeting = () => {
    setMeetingKey((k) => k + 1);
    setMeetingOpen(true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = keyAction({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        inEditable: isEditableTarget(e.target),
      });
      if (!action) return;
      const cal = api();
      e.preventDefault();
      switch (action.type) {
        case 'today':
          cal?.today();
          break;
        case 'prev':
          cal?.prev();
          break;
        case 'next':
          cal?.next();
          break;
        case 'view':
          goView(action.view);
          break;
        case 'create':
          callbacks.current.onCreate();
          break;
        case 'focusSearch':
          searchRef.current?.focus();
          break;
        case 'clearSearch':
          setQuery('');
          setCurrentMatch(null);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [api, goView]);

  const formatTime = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        timeZone: zone,
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      }),
    [locale, zone]
  );
  const formatDay = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        timeZone: 'UTC',
        weekday: 'short',
        day: 'numeric',
      }),
    [locale]
  );
  const formatClock = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        timeZone: zone,
        hour: 'numeric',
        minute: '2-digit',
      }),
    [locale, zone]
  );
  const formatOffset = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(locale, {
        timeZone: zone,
        timeZoneName: 'shortOffset',
      });
    } catch {
      return null;
    }
  }, [locale, zone]);
  const zoneLabel =
    formatOffset?.formatToParts(now).find((p) => p.type === 'timeZoneName')
      ?.value ?? zone;
  const formatHeader = useMemo(
    () => ({
      weekday: new Intl.DateTimeFormat(locale, {
        timeZone: zone,
        weekday: 'short',
      }),
      day: new Intl.DateTimeFormat(locale, { timeZone: zone, day: 'numeric' }),
    }),
    [locale, zone]
  );

  // Day and week views open an hour before now, so the present is in view.
  // Only the mount reads it; later scrolls come from onDatesSet.
  const scrollTime = useMemo(() => gridScrollTime(zone, Date.now()), [zone]);

  const renderDayHeader = (arg: DayHeaderContentArg) => {
    // Month and year headers are weekday names only; keep FullCalendar's.
    if (!arg.view.type.startsWith('timeGrid')) return arg.text;
    return (
      <span
        className={cn(
          'cal-dh',
          arg.isToday && 'cal-dh--today',
          arg.isPast && 'cal-dh--past'
        )}
      >
        <span className="cal-dh__wd">
          {formatHeader.weekday.format(arg.date)}
        </span>
        <span className="cal-dh__num">{formatHeader.day.format(arg.date)}</span>
      </span>
    );
  };

  const renderNow = (arg: NowIndicatorContentArg) =>
    arg.isAxis ? (
      <span className="cal-now">{formatClock.format(arg.date)}</span>
    ) : null;

  const renderEvent = (arg: EventContentArg) => {
    const layout = chipLayout(
      arg.view.type,
      arg.event.allDay,
      arg.event.start?.getTime() ?? null,
      arg.event.end?.getTime() ?? null
    );
    return (
      <EventChip
        item={itemOf(arg.event)}
        layout={layout}
        timeText={arg.timeText}
        startText={
          arg.event.start
            ? arg.view.calendar.formatDate(arg.event.start, EVENT_TIME_FORMAT)
            : arg.timeText
        }
      />
    );
  };

  const rail = (
    <div className="flex flex-col gap-5 p-3">
      <MiniMonth
        cursor={cursor}
        today={wallDateKey(zone, now)}
        marked={marked}
        locale={locale}
        onPick={(key) => {
          api()?.gotoDate(key);
          setSheetOpen(false);
        }}
        prevLabel={t('miniPrev')}
        nextLabel={t('miniNext')}
      />
      <section>
        <h3 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
          {t('layersTitle')}
        </h3>
        <ul className="space-y-1">
          {LAYER_KEYS.map((key) => {
            const disabled = key === 'workspaceMeetings' && !layers.meetings;
            return (
              <li key={key}>
                <label
                  className={cn(
                    'hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm',
                    disabled && 'cursor-not-allowed opacity-50'
                  )}
                >
                  <input
                    type="checkbox"
                    className="accent-primary size-3.5"
                    checked={layers[key]}
                    disabled={disabled}
                    onChange={() => toggleLayer(key)}
                  />
                  <span
                    aria-hidden
                    className="size-2.5 rounded-full"
                    style={{ background: colorVar(LAYER_COLORS[key], 'solid') }}
                  />
                  {t(`layers.${key}`)}
                </label>
              </li>
            );
          })}
        </ul>
      </section>
      <section>
        <h3 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
          {t('upcomingTitle')}
        </h3>
        {upcoming.length === 0 ? (
          <p className="text-muted-foreground px-2 text-sm">
            {t('upcomingEmpty')}
          </p>
        ) : (
          <ul className="space-y-1">
            {upcoming.map((item) => (
              <li key={itemKey(item)}>
                <button
                  type="button"
                  className="hover:bg-muted flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-sm"
                  onClick={(e) => {
                    const anchor = e.currentTarget;
                    api()?.gotoDate(item.start);
                    setSheetOpen(false);
                    callbacks.current.onEventClick(item, anchor);
                  }}
                >
                  <span
                    aria-hidden
                    className="mt-1.5 size-2 shrink-0 rounded-full"
                    style={{ background: colorVar(item.color, 'solid') }}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {item.title}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {item.allDay
                        ? `${formatDay.format(new Date(`${item.start}T00:00:00Z`))} · ${t('allDay')}`
                        : formatTime.format(new Date(itemStartMs(item, zone)))}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="text-muted-foreground px-2 text-xs">{t('shortcuts')}</p>
    </div>
  );

  return (
    <div
      ref={rootRef}
      className="cal-root flex h-[calc(100dvh-7rem)] min-h-[560px] flex-col gap-3"
    >
      <style>{CALENDAR_CSS}</style>
      <header className="flex flex-wrap items-center gap-2">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger
            render={
              <Button variant="outline" size="icon" className="sm:hidden" />
            }
            aria-label={t('openRail')}
          >
            <PanelLeft className="size-4" />
          </SheetTrigger>
          <SheetContent side="left" className="w-72 overflow-y-auto p-0">
            <SheetHeader>
              <SheetTitle>{t('layersTitle')}</SheetTitle>
            </SheetHeader>
            {rail}
          </SheetContent>
        </Sheet>
        <Button
          variant="ghost"
          size="icon"
          className="hidden sm:inline-flex"
          onClick={toggleRail}
          aria-label={railOpen ? t('hideRail') : t('showRail')}
          aria-pressed={railOpen}
        >
          <PanelLeft className="size-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={() => api()?.today()}>
          {t('today')}
        </Button>
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => api()?.prev()}
            aria-label={t('prev')}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => api()?.next()}
            aria-label={t('next')}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <h2 className="min-w-0 truncate text-lg font-semibold">{title}</h2>
        <span
          className="text-muted-foreground hidden items-center gap-1 text-xs whitespace-nowrap md:inline-flex"
          title={zone}
        >
          <Clock className="size-3.5" />
          {formatClock.format(now)} · {zoneLabel}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div
            role="radiogroup"
            aria-label={t('viewSwitcher')}
            className="border-border bg-muted inline-flex rounded-lg border p-0.5"
          >
            {VIEW_KEYS.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={view === v}
                onClick={() => goView(v)}
                className={cn(
                  'text-muted-foreground rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  view === v && 'bg-card text-foreground shadow-sm'
                )}
              >
                {t(`views.${v}`)}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCurrentMatch(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  jumpToNextMatch();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  clearSearch();
                  e.currentTarget.blur();
                }
              }}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchLabel')}
              className="h-8 w-44 pl-8"
            />
            {query.trim() && (
              <span
                className="text-muted-foreground absolute -bottom-4 left-1 text-[10px]"
                aria-live="polite"
              >
                {t('searchCount', { count: matches.length })}
              </span>
            )}
          </div>
          <div className="inline-flex">
            <Button
              size="sm"
              className="rounded-r-none"
              onClick={() => callbacks.current.onCreate()}
            >
              <Plus className="size-4" />
              {t('create')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="sm"
                    className="border-primary-foreground/20 rounded-l-none border-l px-1.5"
                  />
                }
                aria-label={t('createMenu')}
              >
                <ChevronDown className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => callbacks.current.onCreate()}>
                  {t('createEvent')}
                </DropdownMenuItem>
                {canCreateMeeting && (
                  <DropdownMenuItem onClick={openMeeting}>
                    {t('createMeeting')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      {loadError && (
        <p
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
        >
          {t('loadFailed', { reason: loadError })}
        </p>
      )}
      <div className="flex min-h-0 flex-1 gap-3">
        {railOpen && (
          <aside className="border-border bg-card hidden w-64 shrink-0 overflow-y-auto rounded-lg border sm:block">
            {rail}
          </aside>
        )}
        <div className="border-border bg-card min-h-0 min-w-0 flex-1 rounded-lg border p-2">
          <FullCalendar
            ref={calRef}
            plugins={[
              dayGridPlugin,
              timeGridPlugin,
              interactionPlugin,
              listPlugin,
              multiMonthPlugin,
              intlTimeZonePlugin,
            ]}
            timeZone={fcZone}
            locales={FC_LOCALES}
            locale={locale}
            initialView={FC_VIEWS[initialView]}
            initialDate={initialDate ?? undefined}
            headerToolbar={false}
            height="100%"
            firstDay={1}
            nowIndicator
            nowIndicatorContent={renderNow}
            weekNumbers
            scrollTime={scrollTime}
            scrollTimeReset={false}
            slotLabelFormat={{
              hour: 'numeric',
              minute: '2-digit',
              omitZeroMinute: true,
              meridiem: 'short',
            }}
            eventTimeFormat={EVENT_TIME_FORMAT}
            displayEventEnd
            views={{
              dayGridMonth: { displayEventEnd: false },
              multiMonthYear: { displayEventEnd: false },
            }}
            dayHeaderContent={renderDayHeader}
            eventContent={renderEvent}
            businessHours={{
              daysOfWeek: [1, 2, 3, 4, 5],
              startTime: '09:00',
              endTime: '18:00',
            }}
            selectable
            selectMirror
            editable={false}
            eventAllow={(span, moving) => span.allDay === moving?.allDay}
            dayMaxEvents
            eventDisplay="block"
            events={fetchEvents}
            datesSet={onDatesSet}
            select={(info) =>
              callbacks.current.onSelectRange(info.start, info.end, info.allDay)
            }
            eventClick={(info) => {
              info.jsEvent.preventDefault();
              callbacks.current.onEventClick(itemOf(info.event), info.el);
            }}
            eventDrop={(info: EventDropArg) =>
              info.event.start &&
              callbacks.current.onEventChange(
                itemOf(info.event),
                info.event.start,
                info.event.end,
                info.revert
              )
            }
            eventResize={(info: EventResizeDoneArg) =>
              info.event.start &&
              callbacks.current.onEventChange(
                itemOf(info.event),
                info.event.start,
                info.event.end,
                info.revert
              )
            }
            eventClassNames={(arg: EventContentArg) =>
              itemMatches(itemOf(arg.event), query) ? ['cal-ev--match'] : []
            }
            eventDidMount={(arg) => {
              arg.el.dataset.itemKey = itemKey(itemOf(arg.event));
            }}
          />
        </div>
      </div>
      <MeetingFormDialog
        key={meetingKey}
        open={meetingOpen}
        onOpenChange={setMeetingOpen}
        timeZone={zone}
        onSaved={() => refetch(true)}
      />
    </div>
  );
}

function KindIcon({ item }: { item: FeedItem }) {
  if (item.kind === 'meeting') return <Video aria-hidden />;
  if (item.kind === 'task') return <SquareCheck aria-hidden />;
  return null;
}

/** One event's chip, laid out for its view (see `chipLayout`). */
function EventChip({
  item,
  layout,
  timeText,
  startText,
}: {
  item: FeedItem;
  layout: ChipLayout;
  /** FullCalendar's text: a range in the time grid, the start elsewhere. */
  timeText: string;
  startText: string;
}) {
  const name = <span className="cal-chip__name">{item.title}</span>;
  const details = chipDetails(item);

  if (layout === 'full') {
    return (
      <div className="cal-chip cal-chip--full">
        <div className="cal-chip__line">
          <KindIcon item={item} />
          {name}
        </div>
        <div className="cal-chip__line">
          <span className="cal-chip__time">{timeText}</span>
          {details.recurring && <Repeat aria-hidden className="opacity-70" />}
        </div>
        {details.location && (
          <div className="cal-chip__meta">
            <MapPin aria-hidden />
            <span>{details.location}</span>
          </div>
        )}
        {details.attendees > 0 && (
          <div className="cal-chip__meta">
            <Users aria-hidden />
            <span>{details.attendees}</span>
          </div>
        )}
      </div>
    );
  }
  if (layout === 'compact') {
    return (
      <div className="cal-chip cal-chip--compact">
        <KindIcon item={item} />
        {name}
        <span className="cal-chip__time">{startText}</span>
      </div>
    );
  }
  if (layout === 'row') {
    return (
      <div className="cal-chip cal-chip--row">
        <span className="cal-chip__time">{timeText}</span>
        <KindIcon item={item} />
        {name}
      </div>
    );
  }
  if (layout === 'list') {
    return (
      <div className="cal-chip cal-chip--list">
        <KindIcon item={item} />
        {name}
        {details.location && (
          <span className="cal-chip__meta">
            <MapPin aria-hidden />
            <span>{details.location}</span>
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="cal-chip cal-chip--bar">
      <KindIcon item={item} />
      {name}
    </div>
  );
}

function MiniMonth({
  cursor,
  today,
  marked,
  locale,
  onPick,
  prevLabel,
  nextLabel,
}: {
  cursor: string | null;
  today: string;
  marked: ReadonlySet<string>;
  locale: string;
  onPick: (key: string) => void;
  prevLabel: string;
  nextLabel: string;
}) {
  const anchor = cursor ?? today;
  const [shown, setShown] = useState(() => ({
    year: Number(anchor.slice(0, 4)),
    month0: Number(anchor.slice(5, 7)) - 1,
  }));
  // Follow the main calendar when it moves to another month.
  const [lastAnchor, setLastAnchor] = useState(anchor);
  if (anchor !== lastAnchor) {
    setLastAnchor(anchor);
    setShown({
      year: Number(anchor.slice(0, 4)),
      month0: Number(anchor.slice(5, 7)) - 1,
    });
  }

  const weeks = monthGrid(shown.year, shown.month0, 1);
  const label = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(shown.year, shown.month0, 1)));
  const weekday = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'narrow',
  });

  return (
    <section>
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-sm font-semibold">{label}</span>
        <span className="flex">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={prevLabel}
            onClick={() => setShown((s) => addMonths(s.year, s.month0, -1))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={nextLabel}
            onClick={() => setShown((s) => addMonths(s.year, s.month0, 1))}
          >
            <ChevronRight className="size-4" />
          </Button>
        </span>
      </div>
      <div className="text-muted-foreground grid grid-cols-7 text-center text-[11px]">
        {weeks[0].map((d) => (
          <span key={d.key} className="py-1">
            {weekday.format(new Date(`${d.key}T00:00:00Z`))}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center text-xs">
        {weeks.flat().map((d) => (
          <button
            key={d.key}
            type="button"
            onClick={() => onPick(d.key)}
            aria-current={d.key === today ? 'date' : undefined}
            aria-pressed={d.key === cursor}
            className={cn(
              'hover:bg-muted relative mx-auto flex size-7 items-center justify-center rounded-full',
              !d.inMonth && 'text-muted-foreground/60',
              d.key === cursor && 'bg-muted font-semibold',
              d.key === today &&
                'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
          >
            {d.day}
            {marked.has(d.key) && (
              <span
                aria-hidden
                className="absolute bottom-0.5 size-1 rounded-full bg-current opacity-70"
              />
            )}
          </button>
        ))}
      </div>
    </section>
  );
}
