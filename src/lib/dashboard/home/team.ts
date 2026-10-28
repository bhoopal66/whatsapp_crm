import { glanceOf, type Glance } from '@/lib/team-activity/glance';
import {
  numberDisplayName,
  type SenderActivity,
  type TeamActivityReport,
} from '@/lib/team-activity/report';
import { assessReport, type Finding } from '@/lib/team-activity/risk';

// ------------------------------------------------------------
// The home "Team activity today" card: today's report from the Team
// activity route, its four headline figures, and its most urgent
// findings, chosen exactly as the Team activity page chooses them.
// ------------------------------------------------------------

/** How many findings the card lists. */
export const TEAM_FINDINGS_LIMIT = 3;

export interface TeamFinding {
  finding: Finding;
  /** The person it is about, for their name; null otherwise. */
  sender: SenderActivity | null;
  /** The number it is about, named; null otherwise. */
  numberName: string | null;
}

export type TeamToday =
  | { status: 'ok'; glance: Glance; findings: TeamFinding[] }
  /** Migration 068 is not applied (the route answers 503). */
  | { status: 'not_migrated' };

/**
 * The most urgent findings, act now before keep an eye on, one per
 * person or number (`assessReport`'s `today`). A leader never sees the
 * owner's findings; the Safety Meter is not read here.
 */
export function teamFindings(
  report: TeamActivityReport,
  viewer: 'leader' | 'owner',
  limit = TEAM_FINDINGS_LIMIT
): TeamFinding[] {
  const { today } = assessReport(report, { viewer, todayLimit: limit });
  return today.map((finding) => {
    const s = finding.subject;
    if (s.type === 'person') {
      const sender =
        report.senders.find(
          (x) => x.userId === s.userId && x.kind === s.senderKind
        ) ?? null;
      return { finding, sender, numberName: null };
    }
    if (s.type === 'number') {
      const n = report.numbers.find((x) => x.channelId === s.channelId);
      return {
        finding,
        sender: null,
        numberName: n ? numberDisplayName(n) : null,
      };
    }
    return { finding, sender: null, numberName: null };
  });
}

function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Today's team activity. The route computes "today" in the account's
 * saved zone (else the browser's) and returns the report already parsed
 * (`parseTeamActivityReport` runs server-side, so it is not run again).
 */
export async function loadTeamToday(
  viewer: 'leader' | 'owner',
  fetchImpl: typeof fetch = fetch,
  tz: string = viewerZone()
): Promise<TeamToday> {
  const params = new URLSearchParams({ range: 'today', tz });
  const res = await fetchImpl(`/api/team-activity?${params}`, {
    cache: 'no-store',
  });
  if (res.status === 503) return { status: 'not_migrated' };
  if (!res.ok) throw new Error(`/api/team-activity answered ${res.status}`);
  const body = (await res.json()) as { report?: TeamActivityReport } | null;
  if (!body?.report) throw new Error('/api/team-activity sent no report');
  return {
    status: 'ok',
    glance: glanceOf(body.report),
    findings: teamFindings(body.report, viewer),
  };
}
