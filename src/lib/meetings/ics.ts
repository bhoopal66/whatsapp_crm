// ============================================================
// "Add to calendar": one meeting as an iCalendar file (RFC 5545).
// Pure: the clock (DTSTAMP) and the site origin are passed in.
// ============================================================

/** The longest a content line may be, in octets, before folding (3.1). */
const MAX_LINE_OCTETS = 75;

const encoder = new TextEncoder();
const octets = (s: string) => encoder.encode(s).length;

/**
 * Escape a TEXT value (3.3.11): backslash first, then `;`, `,` and
 * every line break as `\n`. Control characters other than tab are not
 * allowed in TEXT, so they are dropped.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/**
 * Fold a content line at 75 octets (3.1): CRLF then one space, which
 * the reader removes. Never splits a UTF-8 character.
 */
export function foldIcsLine(line: string): string {
  if (octets(line) <= MAX_LINE_OCTETS) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  // A continuation line's leading space counts toward its 75.
  let limit = MAX_LINE_OCTETS;
  for (const ch of line) {
    const n = octets(ch);
    if (size + n > limit) {
      parts.push(current);
      current = '';
      size = 0;
      limit = MAX_LINE_OCTETS - 1;
    }
    current += ch;
    size += n;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/** An instant as a UTC DATE-TIME: `20261016T100000Z`. */
export function toIcsUtc(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

export interface IcsMeeting {
  id: string;
  title: string;
  description: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
}

/**
 * The meeting as a VCALENDAR with one VEVENT, CRLF line endings. Null
 * for an instant meeting: it has no time to put in a calendar. The UID
 * is the meeting id at the site's host, so a re-download updates the
 * same calendar entry; URL and the description's last line link to
 * the meeting's page.
 */
export function buildMeetingIcs(
  m: IcsMeeting,
  opts: { origin: string; now: Date }
): string | null {
  if (!m.scheduledStart) return null;
  const origin = opts.origin.replace(/\/+$/, '');
  const url = `${origin}/meetings/${m.id}`;
  const host = new URL(origin).hostname;
  const description = [m.description?.trim(), url].filter(Boolean).join('\n\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Taamul//Meetings//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${m.id}@${host}`,
    `DTSTAMP:${toIcsUtc(opts.now)}`,
    `DTSTART:${toIcsUtc(m.scheduledStart)}`,
    ...(m.scheduledEnd ? [`DTEND:${toIcsUtc(m.scheduledEnd)}`] : []),
    `SUMMARY:${escapeIcsText(m.title)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    `URL:${url}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

/** A download name from the title: `weekly-sync.ics`, else `meeting.ics`. */
export function icsFileName(title: string): string {
  const slug = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${slug || 'meeting'}.ics`;
}
