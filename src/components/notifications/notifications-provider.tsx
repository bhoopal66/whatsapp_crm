'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { startLiveRead } from '@/lib/realtime/catch-up';
import { scopedChangeBindings } from '@/lib/realtime/scoped-changes';
import type { Notification } from '@/types';
import type { NotificationRowPlan } from '@/lib/notifications/target';
import {
  INITIAL_NOTIFICATIONS_STATE,
  changeFromPayload,
  notificationsReducer,
  unreadCount,
  type NotificationChange,
  type NotificationsAction,
} from '@/lib/notifications/store';

/** How many of the latest rows the bell and the page list. */
const WINDOW = 100;

/**
 * Every workspace's rows, as the badge counts them: RLS shows the
 * reader's rows in each workspace where they are live (083's
 * my_live_account_ids()), so this list, "Mark all as read" and the
 * realtime handler all cover the same rows.
 */
async function fetchWindow() {
  const [list, unreadTotal] = await Promise.all([
    createClient()
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(WINDOW),
    fetchUnreadCount(),
  ]);
  if (list.error) throw list.error;
  return { rows: (list.data ?? []) as Notification[], unreadTotal };
}

/**
 * head:true skips fetching rows — we only need the `count` supabase-js
 * returns alongside the (empty) response body. RLS on `notifications`
 * already scopes every read to `auth.uid() = user_id`, so no explicit
 * filter is needed here.
 */
async function fetchUnreadCount(): Promise<number> {
  const { count, error } = await createClient()
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .is('read_at', null);
  if (error) throw error;
  return count ?? 0;
}

interface NotificationsContextValue {
  /** The latest rows, newest first; null until first loaded. */
  notifications: Notification[] | null;
  /** Every unread row, in the list or not (the badge). */
  unread: number;
  /** The last load's failure, cleared by the next load. */
  error: string | null;
  /** A load is in flight. */
  loading: boolean;
  markingAll: boolean;
  /** Fetch the latest rows. Realtime keeps them current afterwards. */
  load: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  /** A row's click: mark it read and open its screen. */
  openNotification: (
    n: Notification,
    plan: NotificationRowPlan
  ) => Promise<void>;
  /** Hears every realtime change, after the list has; answers how to stop. */
  onChange: (fn: (change: NotificationChange) => void) => () => void;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(
  null
);

/**
 * The bell's one source of truth, mounted once by the dashboard shell so
 * the top bar's dropdown and the /notifications page share a list, a
 * count and a single realtime subscription. Only the unread count is
 * fetched up front; the list loads when the dropdown opens or the page
 * mounts.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const tSidebar = useTranslations('Sidebar');
  const t = useTranslations('Notifications');
  const { switchWorkspace, user } = useAuth();
  const userId = user?.id ?? null;
  const [state, dispatch] = useReducer(
    notificationsReducer,
    INITIAL_NOTIFICATIONS_STATE
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  // Only the latest load may land: an older one would roll the list back.
  const loadSeq = useRef(0);
  // A switch to another workspace is in flight (it ends in a page load).
  const switchingRef = useRef(false);
  const listenersRef = useRef(new Set<(change: NotificationChange) => void>());

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const window = await fetchWindow();
      if (seq !== loadSeq.current) return;
      setError(null);
      dispatch({ type: 'loaded', ...window });
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError((err as { message?: string })?.message ?? String(err));
    }
    setLoading(false);
  }, []);

  const listLoadedRef = useRef(false);
  useEffect(() => {
    listLoadedRef.current = state.rows !== null;
  }, [state.rows]);

  // Realtime — new notifications appear and count without a refresh, and
  // a "mark all read" fired from another tab/device stays in sync here.
  // The one subscription for the bell and the page alike.
  //
  // Filtered on the recipient (`user_id` is the auth user id, migration
  // 027), which RLS requires anyway, so Realtime neither checks nor ships
  // anyone else's bells. Deliberately NOT on the account: the bell covers
  // every workspace the person is live in (`my_live_account_ids`, 083),
  // so a workspace switch does not re-subscribe. No user yet: no channel.
  useEffect(() => {
    const bindings = scopedChangeBindings('notifications', 'user_id', userId);
    if (!bindings) return;
    const supabase = createClient();
    // The badge before any list is loaded, and whatever is loaded again
    // after a gap in realtime, quietly: no spinner, no error.
    const live = startLiveRead({
      read: async () => {
        const seq = loadSeq.current;
        const action: NotificationsAction = listLoadedRef.current
          ? { type: 'loaded', ...(await fetchWindow()) }
          : { type: 'count', unread: await fetchUnreadCount() };
        return { seq, action };
      },
      apply: ({ seq, action }) => {
        if (action.type === 'loaded') {
          // A load begun since is newer; one begun before is older, and
          // must not land on top of this.
          if (seq !== loadSeq.current) return;
          loadSeq.current += 1;
          setLoading(false);
          setError(null);
        }
        dispatch(action);
      },
    });
    // The topic names the user: removeChannel is async, and a re-run on
    // the same topic would be handed the channel still leaving.
    let channel = supabase.channel(`notifications-bell:${userId}`);
    for (const binding of bindings) {
      channel = channel.on('postgres_changes', binding, (payload) => {
        const change = changeFromPayload(payload);
        if (!change) return;
        live.changed();
        dispatch(change);
        for (const fn of listenersRef.current) fn(change);
      });
    }
    channel.subscribe(live.onStatus);

    return () => {
      live.stop();
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const markRead = useCallback(
    async (id: string) => {
      // Optimistic — the row is already visually "read" by the time the
      // request lands, so the UI doesn't wait on the round-trip.
      dispatch({ type: 'markRead', id, at: new Date().toISOString() });
      const { error: updateErr } = await createClient()
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', id)
        .is('read_at', null);
      if (updateErr) {
        toast.error(t('markReadFailed'));
        void load();
      }
    },
    [load, t]
  );

  const markAllRead = useCallback(async () => {
    if (unreadCount(state) === 0) return;
    setMarkingAll(true);
    const now = new Date().toISOString();
    dispatch({ type: 'markAllRead', at: now });
    const { error: updateErr } = await createClient()
      .from('notifications')
      .update({ read_at: now })
      .is('read_at', null);
    setMarkingAll(false);
    if (updateErr) {
      toast.error(t('markAllReadFailed'));
      void load();
    }
  }, [state, load, t]);

  // Every type's screen, gated by the reader's role in the row's own
  // workspace: notificationRow in lib/notifications/target.ts.
  const openNotification = useCallback(
    async (n: Notification, plan: NotificationRowPlan) => {
      const { href, otherWorkspace } = plan;
      if (!otherWorkspace || !href) {
        if (!n.read_at) void markRead(n.id);
        if (href) router.push(href);
        return;
      }
      if (switchingRef.current) return;
      switchingRef.current = true;
      // The switch is a full page load, which would cut the read short.
      if (!n.read_at) await markRead(n.id);
      try {
        // Resolves into a page load, so the flag is never reset on success.
        await switchWorkspace(otherWorkspace.accountId, href);
      } catch (err) {
        switchingRef.current = false;
        toast.error(
          tSidebar('workspaceSwitchFailed', {
            reason: err instanceof Error ? err.message : String(err),
          })
        );
      }
    },
    [markRead, router, switchWorkspace, tSidebar]
  );

  const onChange = useCallback((fn: (change: NotificationChange) => void) => {
    const listeners = listenersRef.current;
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  const value = useMemo<NotificationsContextValue>(
    () => ({
      notifications: state.rows,
      unread: unreadCount(state),
      error,
      loading,
      markingAll,
      load,
      markRead,
      markAllRead,
      openNotification,
      onChange,
    }),
    [
      state,
      error,
      loading,
      markingAll,
      load,
      markRead,
      markAllRead,
      openNotification,
      onChange,
    ]
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  );
}

/** The shared bell state; only inside the dashboard shell. */
export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) {
    throw new Error(
      'useNotifications must be used inside NotificationsProvider'
    );
  }
  return ctx;
}
