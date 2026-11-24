"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { guestRedirectPath } from "@/lib/auth/my-workspaces";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { AccountAccessAlert } from "@/components/layout/account-access-alert";
import { SessionReconnecting } from "@/components/layout/session-reconnecting";
import { wasExplicitSignOut } from "@/lib/auth/explicit-sign-out";
import { loginPathFor } from "@/lib/auth/session-state";
import { PushPrompt } from "@/components/layout/push-prompt";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { isFullBleedPath } from "@/lib/layout/full-bleed";
import { MeetingInviteCard } from "@/components/meetings/meeting-invite-card";
import { ReminderAlarm } from "@/components/reminders/reminder-alarm";
import { MeetingSessionProvider } from "@/components/meetings/session/meeting-session-provider";
import { CallProvider } from "@/components/pbx/call-provider";
import { IncomingCallCard } from "@/components/pbx/incoming-call-card";
import { InCallPanel } from "@/components/pbx/in-call-panel";
import { SoftphoneMount } from "@/components/pbx/softphone-mount";
import { AppContextMenu } from "@/components/context-menu/app-context-menu";
import { NotificationsProvider } from "@/components/notifications/notifications-provider";
import { BackNavTracker } from "@/components/layout/back-nav-tracker";
import { UnreadChatsProvider } from "@/components/layout/unread-chats-provider";
import { TabTitle } from "@/components/layout/tab-title";
import { MobileTabBar } from "@/components/layout/mobile-tab-bar";
import { CommandBar } from "@/components/command/command-bar";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.


function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const {
    user,
    loading,
    profileLoading,
    accountRole,
    signingOut,
    sessionStalled,
    retrySession,
  } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  // A bank guest (migrations 082/083) has team chat and nothing else, so
  // any other path sends them to /chat. Hidden links are not access
  // control and neither is this — RLS already gives a guest none of the
  // other screens' data; this spares them a dashboard of empty panels.
  // Null while the role loads: staff pages are not held back for it.
  const guestRedirect = profileLoading
    ? null
    : guestRedirectPath(accountRole, pathname);

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    // A sign-out here removes the session before its request to the
    // server is answered, and then loads /login itself: going there now
    // would have that load wipe whatever was typed on it meanwhile.
    if (!loading && !user && !signingOut) {
      router.push(
        loginPathFor(
          window.location.pathname + window.location.search,
          wasExplicitSignOut(),
        ),
      );
    }
  }, [user, loading, signingOut, router]);

  useEffect(() => {
    if (guestRedirect) router.replace(guestRedirect);
  }, [guestRedirect, router]);

  // The session could not be read yet: not an answer, so no /login.
  if (loading && sessionStalled) {
    return <SessionReconnecting onRetry={retrySession} />;
  }

  if (loading || (!user && signingOut)) {
    return (
      <div className="flex h-app items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  // Nothing of a screen the guest is being moved off.
  if (guestRedirect) return null;

  return (
    // The video call: inside the gate so sign-out ends it, above the
    // pages so moving between them does not.
    <MeetingSessionProvider>
    {/* The call screens (module 015): one incoming-call card and one
        in-call panel for the whole app, over whatever page is open. */}
    <CallProvider>
      {/* The bell: one list, count and realtime subscription for the
          top bar's dropdown and the /notifications page. */}
      <NotificationsProvider>
      {/* The tab's one unread mirror: the sidebar's counts, the tab
          title's "(N)" and the optional new-message sound. */}
      <UnreadChatsProvider>
      {/* `h-app` is the visible screen (100dvh): 100vh on a phone also
          counts the space under the browser's address bar. */}
      <div className="flex h-app overflow-hidden bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      {/* "(N) <page> — Taamul Connect" on the browser tab. Headless. */}
      <TabTitle />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main
          className={
            isFullBleedPath(pathname)
              ? "flex min-h-0 flex-1 flex-col overflow-hidden"
              : "flex-1 overflow-y-auto p-4 sm:p-6"
          }
        >
          {/* Above every page: writes are being rejected and here's why.
              Renders nothing unless the account/role failed to resolve.
              Then the one-time offer to turn on push on this device. A
              full-bleed screen has no padding of its own, so they get it
              here; `empty:hidden` drops the wrapper when both are null. */}
          {isFullBleedPath(pathname) ? (
            <div className="shrink-0 px-4 pt-4 empty:hidden sm:px-6">
              <AccountAccessAlert />
              <PushPrompt />
            </div>
          ) : (
            <>
              <AccountAccessAlert />
              <PushPrompt />
            </>
          )}
          {children}
        </main>
        <MobileTabBar onOpenMenu={() => setSidebarOpen(true)} />
      </div>
      <IncomingCallCard />
      <MeetingInviteCard />
      <ReminderAlarm />
      <InCallPanel />
      <SoftphoneMount />
      {/* The app's own right-click menu, for every screen of the shell. */}
      <AppContextMenu />
      <CommandBar />
      </div>
      </UnreadChatsProvider>
      </NotificationsProvider>
    </CallProvider>
    </MeetingSessionProvider>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      {/* Outside the auth gate so the first page this tab shows is
          recorded too: in-page Back links return to where you came from. */}
      <BackNavTracker />
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
