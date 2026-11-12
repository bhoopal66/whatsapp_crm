// ============================================================
// The times a chat message names (reminder suggestions, migration 197).
//
// Jev answers choices, never free text, so it cannot read a date out of
// a message. This finds every time the message names, deterministically,
// as candidate instants; Jev then judges whether the message is
// something to be reminded of and which candidate it means.
//
// Pure: no clock (the caller passes `now`), no I/O, no Intl state beyond
// time-zone arithmetic. Contract only until implemented.
// ============================================================

/** One time a message names. */
export interface TimeCandidate {
  /** The words as they appear in the message, trimmed, at most 80 chars. */
  phrase: string;
  /** Where the phrase starts in the text (UTF-16 index). */
  index: number;
  /** The instant meant, ISO 8601 in UTC (`toISOString()`). */
  at: string;
  /** A day was named but no time of day: `at` is 09:00 in `timeZone`. */
  dateOnly: boolean;
}

export interface FindTimeOptions {
  /** When the message was written; relative words count from here. */
  now: Date;
  /** IANA zone the words are read in (the account's saved zone, else UTC). */
  timeZone: string;
  /** Most candidates returned, in order of appearance. Default 4. */
  max?: number;
}

/** Every future time the message names, in order of appearance. */
export function findTimePhrases(
  text: string,
  opts: FindTimeOptions
): TimeCandidate[] {
  void text;
  void opts;
  return [];
}
