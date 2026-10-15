"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Notification } from "@/types";
import {
  AtSign,
  Bell,
  Bot,
  CalendarClock,
  CheckCheck,
  DoorOpen,
  Handshake,
  ListTodo,
  Loader2,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  PhoneMissed,
  PhoneOff,
  ClipboardPen,
  PhoneCall,
  PhoneOutgoing,
  ShieldAlert,
  UserPlus,
  Video,
  Wifi,
  WifiOff,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  notificationRow,
  type NotificationRowPlan,
} from "@/lib/notifications/target";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// Icon per notification type — a one-line add per new type.
const TYPE_ICON: Record<Notification["type"], typeof Bell> = {
  conversation_assigned: UserPlus,
  channel_disconnected: WifiOff,
  channel_reconnected: Wifi,
  team_activity_alert: ShieldAlert,
  ai_handoff: Bot,
  task_assigned: ListTodo,
  task_due: CalendarClock,
  chat_mention: AtSign,
  chat_dm: MessageCircle,
  chat_thread_reply: MessagesSquare,
  chat_broadcast: Megaphone,
  call_missed: PhoneMissed,
  callback_requested: PhoneOutgoing,
  call_outcome_due: ClipboardPen,
  pbx_connection_silent: PhoneOff,
  pbx_connection_restored: PhoneCall,
  deal_room_join_request: DoorOpen,
  deal_room_update: Handshake,
  meeting_invite: Video,
};

// A channel alert's body is the fix (who re-pairs which phone, where),
// so it is shown whole rather than cut to one line like an assignment.
const FULL_BODY: ReadonlySet<Notification["type"]> = new Set([
  "channel_disconnected",
  "channel_reconnected",
  "team_activity_alert",
  "pbx_connection_silent",
  "pbx_connection_restored",
]);

export default function NotificationsPage() {
  const router = useRouter();
  const tSidebar = useTranslations("Sidebar");
  const tBell = useTranslations("Workspaces.bell");
  const {
    accountId,
    accountRole,
    activeWorkspaceId,
    workspaces,
    switchWorkspace,
  } = useAuth();
  const [notifications, setNotifications] = useState<Notification[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  // A switch to another workspace is in flight (it ends in a page load).
  const switchingRef = useRef(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    // Every workspace's rows, as the badge counts them: RLS shows the
    // reader's rows in each workspace where they are live (083's
    // my_live_account_ids()), so this list, "Mark all as read" and the
    // realtime handler below all cover the same rows.
    const { data, error: fetchErr } = await supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (fetchErr) {
      setError(fetchErr.message);
      return;
    }
    setNotifications((data ?? []) as Notification[]);
  }, [accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Realtime — new assignments appear without a refresh, and a
  // "mark all read" fired from another tab/device stays in sync here.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("notifications-page")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const row = payload.new as Notification;
            setNotifications((prev) => {
              if (!prev) return [row];
              if (prev.some((n) => n.id === row.id)) return prev;
              return [row, ...prev];
            });
          } else if (payload.eventType === "UPDATE") {
            const row = payload.new as Notification;
            setNotifications((prev) =>
              prev?.map((n) => (n.id === row.id ? { ...n, ...row } : n)) ??
              prev,
            );
          } else if (payload.eventType === "DELETE") {
            const oldRow = payload.old as Partial<Notification>;
            setNotifications(
              (prev) => prev?.filter((n) => n.id !== oldRow.id) ?? prev,
            );
          }
        },
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
      setNotifications(
        (prev) =>
          prev?.map((n) =>
            n.id === id && !n.read_at
              ? { ...n, read_at: new Date().toISOString() }
              : n,
          ) ?? prev,
      );
      const supabase = createClient();
      const { error: updateErr } = await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", id)
        .is("read_at", null);
      if (updateErr) {
        toast.error("Failed to mark notification as read");
        load();
      }
    },
    [load],
  );

  // Every type's screen, gated by the reader's role in the row's own
  // workspace: notificationRow in lib/notifications/target.ts.
  const handleClick = useCallback(
    async (n: Notification, plan: NotificationRowPlan) => {
      const { href, otherWorkspace } = plan;
      if (!otherWorkspace || !href) {
        if (!n.read_at) markRead(n.id);
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
          tSidebar("workspaceSwitchFailed", {
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    },
    [markRead, router, switchWorkspace, tSidebar],
  );

  const unreadIds = notifications?.filter((n) => !n.read_at).map((n) => n.id) ?? [];

  const markAllRead = useCallback(async () => {
    if (unreadIds.length === 0) return;
    setMarkingAll(true);
    const now = new Date().toISOString();
    setNotifications(
      (prev) => prev?.map((n) => (n.read_at ? n : { ...n, read_at: now })) ?? prev,
    );
    const supabase = createClient();
    const { error: updateErr } = await supabase
      .from("notifications")
      .update({ read_at: now })
      .is("read_at", null);
    setMarkingAll(false);
    if (updateErr) {
      toast.error("Failed to mark all as read");
      load();
    }
  }, [unreadIds.length, load]);

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    );
  }

  if (notifications === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Notifications</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Conversations other teammates assign to you show up here, and
            for admins, alerts when a WhatsApp number goes offline.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={unreadIds.length === 0 || markingAll}
          onClick={markAllRead}
        >
          {markingAll ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCheck className="h-4 w-4" />
          )}
          Mark all as read
        </Button>
      </div>

      {notifications.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/40">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <Bell className="h-6 w-6 text-primary" />
          </div>
          <p className="mt-3 text-sm font-medium text-foreground">
            No notifications yet
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            You&apos;ll see an alert here when someone assigns you a
            conversation.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {notifications.map((n) => {
            const Icon = TYPE_ICON[n.type] ?? Bell;
            const isUnread = !n.read_at;
            const plan = notificationRow(n, {
              activeWorkspaceId,
              activeRole: accountRole,
              workspaces,
            });
            const workspaceName = plan.otherWorkspace
              ? (plan.otherWorkspace.name ?? tBell("unknown"))
              : null;
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => void handleClick(n, plan)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors",
                    isUnread
                      ? "border-primary/30 bg-primary/5 hover:border-primary/50"
                      : "border-border bg-card hover:border-border/70",
                  )}
                >
                  <div
                    className={cn(
                      "flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg",
                      isUnread ? "bg-primary/15" : "bg-muted",
                    )}
                    aria-hidden
                  >
                    <Icon
                      className={cn(
                        "h-5 w-5",
                        isUnread ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "truncate text-sm font-semibold",
                          isUnread ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {n.title}
                      </span>
                      {workspaceName && (
                        <span
                          title={tBell("switchHint", { name: workspaceName })}
                          className="max-w-40 flex-shrink-0 truncate rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                        >
                          {workspaceName}
                        </span>
                      )}
                      {isUnread && (
                        <span
                          aria-label="Unread"
                          className="h-2 w-2 flex-shrink-0 rounded-full bg-primary"
                        />
                      )}
                    </div>
                    {n.body && (
                      <p
                        className={cn(
                          "mt-0.5 text-xs text-muted-foreground",
                          FULL_BODY.has(n.type)
                            ? "whitespace-normal"
                            : "truncate",
                        )}
                      >
                        {n.body}
                      </p>
                    )}
                    <p className="mt-1 text-[11px] text-muted-foreground/70">
                      {formatDistanceToNow(new Date(n.created_at), {
                        addSuffix: true,
                      })}
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
