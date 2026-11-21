/**
 * Desk WhatsApp routing and the tray (migration 230, design 035 slice
 * C): types shared by the store, the routes and the Tray tab. Pure.
 *
 * The router never chooses between cases on a guess: E1 (a reply to our
 * message naming a case), E2 (a caption code) or E4 (the only open case
 * of a one-company sender) may file; anything else lands in the tray
 * with every candidate and none selected. `tray.test.ts` pins the
 * reasons to 230's CHECK.
 */

export const TRAY_REASONS = [
  'unknown_sender',
  'no_open_case',
  'many_companies',
  'many_cases',
  'evidence_conflict',
  'other_person',
  'file_refused',
] as const;
export type TrayReason = (typeof TRAY_REASONS)[number];

export type TrayState = 'open' | 'filed' | 'dismissed';

/** Why a case is listed: 230's `why` values. */
export type CandidateWhy = 'quoted' | 'code' | 'prompt' | 'sender';

export interface TrayCandidate {
  caseId: string;
  caseNumber: string | null;
  bankCode: string;
  company: string;
  product: string | null;
  why: CandidateWhy[];
}

export interface TrayItem {
  trayId: string;
  reason: TrayReason;
  candidates: TrayCandidate[];
  state: TrayState;
  receivedAt: string;
  ageSeconds: number;
  escalatedAt: string | null;
  dutyUserId: string | null;
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  senderCompanies: { company: string; role: string }[];
  documentKind: string | null;
  mime: string | null;
  originalName: string | null;
  caption: string | null;
  mediaUrl: string | null;
  resolvedCaseId: string | null;
  dismissReason: string | null;
}

export interface DeskSettings {
  routingEnabled: boolean;
  deskChannelIds: string[];
  dutyUserId: string | null;
  escalateMinutes: number;
  updatedAt: string | null;
}

/** The router's answer for one document. */
export interface RouteDecision {
  action: 'off' | 'ignored' | 'filed' | 'tray' | 'staff';
  caseId: string | null;
  trayId: string | null;
  reason: TrayReason | null;
  staffUserId: string | null;
}

/**
 * Does filing to this candidate need the company's name typed? Yes when
 * the sender acts for no company of that name (230's CONFIRM_COMPANY).
 */
export function needsCompanyConfirm(
  item: Pick<TrayItem, 'senderCompanies'>,
  candidate: Pick<TrayCandidate, 'company'>
): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return !item.senderCompanies.some(
    (c) => norm(c.company) === norm(candidate.company)
  );
}

export function parseCandidates(v: unknown): TrayCandidate[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((c) => {
    if (!c || typeof c !== 'object') return [];
    const o = c as Record<string, unknown>;
    if (typeof o.case_id !== 'string') return [];
    return [
      {
        caseId: o.case_id,
        caseNumber: typeof o.case_number === 'string' ? o.case_number : null,
        bankCode: String(o.bank_code ?? ''),
        company: String(o.company ?? ''),
        product: typeof o.product === 'string' ? o.product : null,
        why: Array.isArray(o.why)
          ? (o.why.filter((w) =>
              ['quoted', 'code', 'prompt', 'sender'].includes(String(w))
            ) as CandidateWhy[])
          : [],
      },
    ];
  });
}
