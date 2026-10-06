// ============================================================
// The shape of a Whapi Safety Meter reading as the Team activity page
// receives it (GET/POST /api/team-activity/safety). Types only, so the
// browser can import it without pulling in the gateway client.
// ============================================================

/** 1 = use caution, 2 = needs attention, 3 = good; null when absent. */
export type SafetyScore = 1 | 2 | 3 | null;

export interface SafetyReading {
  /** The overall rating. */
  riskFactor: SafetyScore;
  /** The number's age on WhatsApp. */
  lifeTime: SafetyScore;
  /** The response rate to the number's chats. */
  riskFactorChats: SafetyScore;
  /** How much of its messaging goes to contacts in its address book. */
  riskFactorContacts: SafetyScore;
  /** When Whapi last calculated it, as Whapi wrote it (M/D/YYYY). */
  lastUpdate: string | null;
}

export interface SafetyEntry {
  channelId: string;
  rating: SafetyReading | null;
  /** 'refused' (the token was not accepted) or 'unavailable'; null when read. */
  error: 'refused' | 'unavailable' | null;
  checkedAt: string;
}
