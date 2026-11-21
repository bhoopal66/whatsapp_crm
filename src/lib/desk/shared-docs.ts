/**
 * One document across a company's bank cases (migration 231, design 035
 * D5/D11/D13): the company overview the Companies tab shows, parsed
 * defensively. Pure.
 *
 * Every case of the company is listed with its stage only; files are
 * those of the cases the viewer can read; a file is `shared` when the
 * same stored document is on more than one of the company's cases. A
 * document is reused at another bank only with the company's live
 * consent for that bank.
 */

export interface OverviewCase {
  caseId: string;
  caseNumber: string | null;
  bankCode: string;
  product: string | null;
  stage: string;
  closed: boolean;
  canRead: boolean;
  canWrite: boolean;
}

export interface OverviewFile {
  fileId: string;
  caseId: string;
  customerDocumentId: string;
  docKey: string | null;
  status: string;
  version: number | null;
  expiresOn: string | null;
  originalName: string | null;
  kind: string | null;
  registeredAt: string;
  shared: boolean;
}

export interface OverviewConsent {
  bankCode: string;
  evidence: string;
  grantedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface CompanyOverview {
  cases: OverviewCase[];
  files: OverviewFile[];
  consents: OverviewConsent[];
}

const s = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[])
    : [];

export function parseCompanyOverview(v: unknown): CompanyOverview {
  const o =
    v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  // A jsonb RPC may arrive wrapped in its function name's key.
  const body =
    'cases' in o
      ? o
      : ((Object.values(o)[0] as Record<string, unknown> | undefined) ?? {});
  return {
    cases: arr(body.cases).flatMap((c) =>
      s(c.case_id)
        ? [
            {
              caseId: String(c.case_id),
              caseNumber: s(c.case_number),
              bankCode: String(c.bank_code ?? ''),
              product: s(c.product),
              stage: String(c.stage ?? ''),
              closed: c.closed === true,
              canRead: c.can_read === true,
              canWrite: c.can_write === true,
            },
          ]
        : []
    ),
    files: arr(body.files).flatMap((f) =>
      s(f.file_id) && s(f.case_id)
        ? [
            {
              fileId: String(f.file_id),
              caseId: String(f.case_id),
              customerDocumentId: String(f.customer_document_id ?? ''),
              docKey: s(f.doc_key),
              status: String(f.status ?? ''),
              version: typeof f.version === 'number' ? f.version : null,
              expiresOn: s(f.expires_on),
              originalName: s(f.original_name),
              kind: s(f.kind),
              registeredAt: String(f.registered_at ?? ''),
              shared: f.shared === true,
            },
          ]
        : []
    ),
    consents: arr(body.consents).flatMap((c) =>
      s(c.bank_code)
        ? [
            {
              bankCode: String(c.bank_code),
              evidence: String(c.evidence ?? ''),
              grantedAt: String(c.granted_at ?? ''),
              revokedAt: s(c.revoked_at),
              revokeReason: s(c.revoke_reason),
            },
          ]
        : []
    ),
  };
}

/** The banks with a live consent. */
export function consentedBanks(o: CompanyOverview): Set<string> {
  return new Set(o.consents.filter((c) => !c.revokedAt).map((c) => c.bankCode));
}

/**
 * Where a file may be linked: another open case of the company that the
 * viewer can write and that does not hold the same document yet. A case
 * at another bank needs that bank's consent (`needsConsent`).
 */
export function linkTargets(
  o: CompanyOverview,
  file: OverviewFile
): { target: OverviewCase; needsConsent: boolean }[] {
  const from = o.cases.find((c) => c.caseId === file.caseId);
  const banks = consentedBanks(o);
  return o.cases
    .filter(
      (c) =>
        c.caseId !== file.caseId &&
        !c.closed &&
        c.canWrite &&
        !o.files.some(
          (f) =>
            f.caseId === c.caseId &&
            f.customerDocumentId === file.customerDocumentId
        )
    )
    .map((c) => ({
      target: c,
      needsConsent: c.bankCode !== from?.bankCode && !banks.has(c.bankCode),
    }));
}
