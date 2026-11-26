import { describe, expect, it } from "vitest";

import {
  OFFLINE_AFTER_MS,
  derivePresence,
  presenceTooltip,
  summarize,
} from "./presence";

// Fixed reference clock so every case is deterministic.
const NOW = new Date("2026-06-22T12:00:00.000Z").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("derivePresence", () => {
  it("returns the stored status for a fresh heartbeat", () => {
    expect(derivePresence("online", ago(1_000), NOW)).toBe("online");
    expect(derivePresence("away", ago(1_000), NOW)).toBe("away");
  });

  it("reads as offline when the heartbeat is stale", () => {
    expect(derivePresence("online", ago(OFFLINE_AFTER_MS + 1_000), NOW)).toBe(
      "offline",
    );
    // Stored 'away' goes stale to offline too (tab was closed while idle).
    expect(derivePresence("away", ago(OFFLINE_AFTER_MS + 1_000), NOW)).toBe(
      "offline",
    );
  });

  it("treats a missing row or timestamp as offline", () => {
    expect(derivePresence(undefined, null, NOW)).toBe("offline");
    expect(derivePresence("online", null, NOW)).toBe("offline");
    expect(derivePresence("online", "not-a-date", NOW)).toBe("offline");
  });

  it("stays online exactly at the threshold and flips just past it", () => {
    expect(derivePresence("online", ago(OFFLINE_AFTER_MS), NOW)).toBe("online");
    expect(derivePresence("online", ago(OFFLINE_AFTER_MS + 1), NOW)).toBe(
      "offline",
    );
  });
});

describe("presenceTooltip", () => {
  it("names each state for the tooltip", () => {
    expect(presenceTooltip("online", ago(1_000), NOW)).toEqual({
      key: "onlineNow",
    });
    expect(presenceTooltip("away", ago(1_000), NOW)).toEqual({
      key: "awayIdle",
    });
    expect(presenceTooltip("offline", ago(2 * 60 * 60_000), NOW)).toEqual({
      key: "offlineSince",
      lastSeen: new Date(NOW - 2 * 60 * 60_000),
    });
  });

  it("never sees anyone in the future, and says so when it does not know", () => {
    expect(presenceTooltip("offline", ago(-60_000), NOW)).toEqual({
      key: "offlineSince",
      lastSeen: new Date(NOW),
    });
    expect(presenceTooltip("offline", null, NOW)).toEqual({
      key: "offlineUnknown",
    });
    expect(presenceTooltip("offline", "nonsense", NOW)).toEqual({
      key: "offlineUnknown",
    });
  });
});

describe("summarize", () => {
  it("counts each status", () => {
    expect(
      summarize(["online", "online", "online", "away", "offline"]),
    ).toEqual({ online: 3, away: 1, offline: 1 });
  });

  it("returns zeroes for an empty roster", () => {
    expect(summarize([])).toEqual({ online: 0, away: 0, offline: 0 });
  });
});
