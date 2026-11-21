/**
 * The case file reviewer's deterministic checklist (package 031a), pure.
 * Per required document of the case's file spec (181): received,
 * missing, pending, rejected, failed or expired, plus flags where the
 * checklist (case_documents) and the files disagree. Always written into
 * a draft; the model narrative, when there is one, only adds to it.
 */

export interface ReviewRequirement {
  docKey: string;
  label: string;
  position: number;
  required: boolean;
}
export interface ReviewDocument {
  docKey: string;
  status: 'requested' | 'received' | 'rejected';
}
export interface ReviewFile {
  fileId: string;
  docKey: string | null;
  version: number | null;
  /** The bytes' sha256 when known (the NAS worker fills it), else the document id. */
  identity: string;
  status:
    'unclassified' | 'pending_checks' | 'passed' | 'failed' | 'superseded';
  checks: Array<{ name: string; ok: boolean }>;
  expiresOn: string | null;
}

export type ItemState =
  'received' | 'missing' | 'pending' | 'rejected' | 'failed' | 'expired';
export interface ChecklistItem {
  docKey: string;
  label: string;
  required: boolean;
  state: ItemState;
  fileId: string | null;
  failedChecks: string[];
  expiresOn: string | null;
}
export type FlagCode =
  | 'RECEIVED_WITHOUT_PASSED_FILE'
  | 'PASSED_FILE_NOT_RECEIVED'
  | 'UNEXPECTED_DOCUMENT'
  | 'UNCLASSIFIED_FILES'
  | 'DUPLICATE_FILE'
  | 'NEEDS_MANUAL_REVIEW'
  | 'REDACTION_FAILED_MODEL_SKIPPED'
  | 'MODEL_ERROR'
  | 'MODEL_NOT_CONFIGURED';
export interface ReviewFlag {
  code: FlagCode;
  docKey?: string;
  detail: string;
}
export interface Checklist {
  items: ChecklistItem[];
  flags: ReviewFlag[];
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export function buildChecklist(
  requirements: readonly ReviewRequirement[],
  documents: readonly ReviewDocument[],
  files: readonly ReviewFile[],
  now: Date
): Checklist {
  const today = day(now);
  const live = files.filter((f) => f.status !== 'superseded');
  const docs = new Map(documents.map((d) => [d.docKey, d]));
  const reqKeys = new Set(requirements.map((r) => r.docKey));
  const flags: ReviewFlag[] = [];
  const items = [...requirements]
    .sort((a, b) => a.position - b.position || a.docKey.localeCompare(b.docKey))
    .map((r): ChecklistItem => {
      const mine = live
        .filter((f) => f.docKey === r.docKey && f.status !== 'unclassified')
        .sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
      const latest = mine[0];
      const passed = mine.find((f) => f.status === 'passed');
      const doc = docs.get(r.docKey);
      const base = {
        docKey: r.docKey,
        label: r.label,
        required: r.required,
        fileId: latest?.fileId ?? null,
        failedChecks: [] as string[],
        expiresOn: null as string | null,
      };
      if (doc?.status === 'received' && !passed)
        flags.push({
          code: 'RECEIVED_WITHOUT_PASSED_FILE',
          docKey: r.docKey,
          detail: 'marked received but no file passed its checks',
        });
      if (passed && doc?.status !== 'received')
        flags.push({
          code: 'PASSED_FILE_NOT_RECEIVED',
          docKey: r.docKey,
          detail: `a file passed but the document is ${doc?.status ?? 'not recorded'}`,
        });
      if (doc?.status === 'rejected') return { ...base, state: 'rejected' };
      if (latest?.status === 'failed')
        return {
          ...base,
          state: 'failed',
          failedChecks: latest.checks.filter((c) => !c.ok).map((c) => c.name),
        };
      if (latest?.status === 'pending_checks')
        return { ...base, state: 'pending' };
      if (passed) {
        if (passed.expiresOn && passed.expiresOn < today)
          return {
            ...base,
            fileId: passed.fileId,
            state: 'expired',
            expiresOn: passed.expiresOn,
          };
        return {
          ...base,
          fileId: passed.fileId,
          state: 'received',
          expiresOn: passed.expiresOn,
        };
      }
      if (doc?.status === 'received') return { ...base, state: 'received' };
      return { ...base, state: 'missing' };
    });
  for (const k of [
    ...new Set(
      live
        .filter((f) => f.docKey && !reqKeys.has(f.docKey))
        .map((f) => f.docKey!)
    ),
  ].sort())
    flags.push({
      code: 'UNEXPECTED_DOCUMENT',
      docKey: k,
      detail: 'a file is classified as a document this case does not require',
    });
  const unclassified = live.filter((f) => f.status === 'unclassified').length;
  if (unclassified)
    flags.push({
      code: 'UNCLASSIFIED_FILES',
      detail: `${unclassified} file(s) not yet classified`,
    });
  const byIdentity = new Map<string, Set<string>>();
  for (const f of live)
    if (f.docKey)
      byIdentity.set(
        f.identity,
        (byIdentity.get(f.identity) ?? new Set()).add(f.docKey)
      );
  for (const keys of byIdentity.values())
    if (keys.size > 1)
      flags.push({
        code: 'DUPLICATE_FILE',
        detail: `the same file is used for ${[...keys].sort().join(', ')}`,
      });
  return { items, flags };
}

/** The checklist as plain text: the deterministic narrative, and the model's checklist input. */
export function checklistText(c: Checklist): string {
  const req = c.items.filter((i) => i.required);
  const got = req.filter((i) => i.state === 'received').length;
  const lines = [`${got} of ${req.length} required documents received.`];
  for (const i of c.items) {
    let s = `- ${i.label} (${i.docKey}${i.required ? '' : ', optional'}): ${i.state}`;
    if (i.failedChecks.length)
      s += ` [failed checks: ${i.failedChecks.join(', ')}]`;
    if (i.expiresOn) s += ` [expires ${i.expiresOn}]`;
    lines.push(s);
  }
  for (const f of c.flags)
    lines.push(`! ${f.code}${f.docKey ? ` (${f.docKey})` : ''}: ${f.detail}`);
  return lines.join('\n');
}
