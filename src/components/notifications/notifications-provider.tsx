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
import type { Notification } from '@/types';
import type { NotificationRowPlan } from '@/lib/notifications/target';
import {
  INITIAL_NOTIFICATIONS_STATE,
  notificationsReducer,
  unreadCount,
} from '@/lib/notifications/store';

/** How many of the latest rows the bell and the page list. */
const WINDOW = 100;

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
  const { switchWorkspace } = useAuth();
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

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    const supabase = createClient();
    // Every workspace's rows, as the badge counts them: RLS shows the
    // reader's rows in each workspace where they are live (083's
    // my_live_account_ids()), so this list, "Mark all as read" and the
    // realtime handler below all cover the same rows.
    const [list, count] = await Promise.all([
      supabase
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(WINDOW),
      supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .is('read_at', null),
    ]);
    if (seq !== loadSeq.current) return;
    setLoading(false);
    const failure = list.error ?? count.error;
    if (failure) {
      setError(failure.message);
      return;
    }
    setError(null);
    dispatch({
      type: 'loaded',
      rows: (list.data ?? []) as Notification[],
      unreadTotal: count.count ?? 0,
    });
  }, []);

  // The badge before any list is loaded. head:true skips fetching rows —
  // we only need the `count` supabase-js returns alongside the (empty)
  // response body. RLS on `notifications` already scopes every read to
  // `auth.uid() = user_id`, so no explicit filter is needed here.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { count, error: countErr } = await createClient()
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .is('read_at', null);
      if (cancelled || countErr) return;
      dispatch({ type: 'count', unread: count ?? 0 });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Realtime — new notifications appear and count without a refresh, and
  // a "mark all read" fired from another tab/device stays in sync here.
  // The one subscription for the bell and the page alike.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel('notifications-bell')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            dispatch({ type: 'insert', row: payload.new as Notification });
          } else if (payload.eventType === 'UPDATE') {
            dispatch({ type: 'update', row: payload.new as Notification });
          } else if (payload.eventType === 'DELETE') {
            dispatch({
              type: 'delete',
              row: payload.old as Partial<Notification>,
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

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
