"use client";

import { useEffect } from "react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { StoredPresence } from "@/lib/presence";
import { startPresenceTabs } from "@/lib/presence-tabs";

/**
 * PresenceHeartbeat — headless. Mount ONCE per signed-in dashboard tab
 * (in the dashboard shell, below the auth gate). Reports this tab's
 * presence to the `member_presence` table via the `touch_presence` RPC
 * roughly every HEARTBEAT_MS.
 *
 * Only one tab of the browser beats, for all of them (presence-tabs.ts).
 * The client only ever reports 'online' or 'away':
 *   - 'online' while some tab is on screen and was used within IDLE_AFTER_MS
 *   - 'away'   otherwise
 * It keeps heartbeating while away (so the row stays fresh, i.e. not
 * offline). When the tab closes the beats simply stop and viewers derive
 * 'offline' from staleness — no unreliable unload write needed.
 */
export function PresenceHeartbeat() {
  const { accountId } = useAuth();

  useEffect(() => {
    // Hold off until the account is known. Beating during the brief
    // window on a fresh signup — authed but profile/account row not yet
    // created — would make touch_presence raise "No account for caller"
    // and log a spurious error. The effect re-runs once accountId lands.
    if (!accountId) return;

    const supabase = createClient();
    let cancelled = false;
    let lastBeatAt = 0;
    const beat = async (status: StoredPresence) => {
      if (cancelled) return;
      // Coalesce bursts: a tab refocus fires visibilitychange AND focus
      // together, so skip a beat within 1s of the last to avoid two RPCs
      // in the same frame. The 30s interval is never affected.
      const t = Date.now();
      if (t - lastBeatAt < 1_000) return;
      lastBeatAt = t;
      const { error } = await supabase.rpc("touch_presence", {
        p_status: status,
      });
      if (error && !cancelled) {
        // Non-fatal: presence is best-effort. Log once per failure so a
        // misconfigured RPC is visible without spamming.
        console.error("[PresenceHeartbeat] touch_presence failed:", error.message);
      }
    };

    const name = `wacrm-presence:${accountId}`;
    const tabs = startPresenceTabs({
      name,
      // Not randomUUID: it needs https, which a LAN install may lack.
      id: Math.random().toString(36).slice(2),
      locks: navigator.locks ?? null,
      channel:
        typeof BroadcastChannel === "undefined"
          ? null
          : new BroadcastChannel(name),
      isVisible: () => !document.hidden,
      beat: (status) => void beat(status),
    });

    // Activity listeners. `passive` so we never block scroll/input.
    const activityEvents: (keyof DocumentEventMap)[] = [
      "mousemove",
      "keydown",
      "pointerdown",
      "scroll",
    ];
    activityEvents.forEach((e) =>
      document.addEventListener(e, tabs.active, { passive: true }),
    );

    // Returning to the tab should beat immediately so a member flips
    // back to online without a 30s wait. The debounce in beat() absorbs
    // the visibilitychange + focus double-fire.
    const onReturn = () => tabs.changed();
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);

    // A closing tab says so, rather than be counted until it goes stale.
    const onLeave = () => tabs.leave();
    window.addEventListener("pagehide", onLeave);

    return () => {
      cancelled = true;
      tabs.stop();
      activityEvents.forEach((e) =>
        document.removeEventListener(e, tabs.active),
      );
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("pagehide", onLeave);
    };
  }, [accountId]);

  return null;
}
