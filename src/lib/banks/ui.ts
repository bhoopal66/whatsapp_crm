/**
 * The Banks screens (module 019): pure helpers behind /banks and
 * /banks/[id]. Client-safe: it must not import lib/cases/bank-workspaces
 * (server code, and an internal module never-sent.test.ts tracks), so the
 * pin kinds and caps are restated here and ui.test.ts keeps them equal.
 * INTERNAL TEXT: nothing parsed here is ever sent to a customer or a bank.
 */

export const PIN_KINDS = [
  'bank_contacts',
  'product_rules',
  'required_documents',
  'turnaround_times',
  'known_pitfalls',
] as const;
export type PinKind = (typeof PIN_KINDS)[number];

export const BANK_CAPS = { title: 200, body: 4000, pin: 8000 } as const;

export const BANK_TABS = [
  'threads',
  'pinned',
  'actions',
  'cases',
  'dashboard',
] as const;
export type BankTab = (typeof BANK_TABS)[number];

/** `?tab=` -> a known tab, else Threads. */
export function bankTab(v: string | null | undefined): BankTab {
  return (BANK_TABS as readonly string[]).includes(v ?? '')
    ? (v as BankTab)
    : 'threads';
}

export interface BankSpace {
  bankWsId: string;
  bankCode: string;
  bankName: string;
  access: 'admin' | 'member';
  createdAt: string | null;
}
export interface CreatableBank {
  code: string;
  name: string;
}
export interface BankCase {
  caseId: string;
  stage: string;
  product: string | null;
  agentId: string | null;
  coordinatorId: string | null;
  openedAt: string | null;
  closedAt: string | null;
  contactId: string | null;
  contactName: string | null;
  slaState: string | null;
  nextDueAt: string | null;
  isLead: boolean;
}
export interface BankThread {
  threadId: string;
  title: string;
  authorId: string | null;
  createdAt: string | null;
  caseId: string | null;
  taskId: string | null;
  postCount: number;
  actionOwnerId: string | null;
  actionDueAt: string | null;
}
export interface BankPost {
  postId: string;
  parentPostId: string | null;
  authorId: string | null;
  body: string | null;
  retracted: boolean;
  caseId: string | null;
  caseReadable: boolean;
  caseStage: string | null;
  caseProduct: string | null;
  createdAt: string | null;
}
export interface BankPin {
  pinId: string;
  kind: PinKind;
  body: string;
  authorId: string | null;
  createdAt: string | null;
}
export interface BankAction {
  actionId: string;
  threadId: string;
  ownerId: string | null;
  dueAt: string | null;
  caseId: string | null;
  taskId: string | null;
  taskStatus: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;
const count = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : 0;
};

/** The array under `key`, each item parsed, the unusable ones dropped. */
function list<T>(json: unknown, key: string, one: (r: Obj) => T | null): T[] {
  if (!isObj(json) || !Array.isArray(json[key])) return [];
  return (json[key] as unknown[])
    .map((r) => (isObj(r) ? one(r) : null))
    .filter((r): r is T => r !== null);
}

function space(r: Obj): BankSpace | null {
  const id = str(r.bankWsId);
  const code = str(r.bankCode);
  if (!id || !code) return null;
  return {
    bankWsId: id,
    bankCode: code,
    bankName: str(r.bankName) ?? code,
    access: r.access === 'admin' ? 'admin' : 'member',
    createdAt: str(r.createdAt),
  };
}

/** GET /api/banks. */
export function parseBankList(json: unknown): {
  workspaces: BankSpace[];
  creatable: CreatableBank[];
} {
  return {
    workspaces: list(json, 'workspaces', space),
    creatable: list(json, 'creatable', (r) => {
      const code = str(r.code);
      return code ? { code, name: str(r.name) ?? code } : null;
    }),
  };
}

/** GET /api/banks/[id]; workspace null when the body is unusable. */
export function parseBankPage(json: unknown): {
  workspace: BankSpace | null;
  cases: BankCase[];
} {
  return {
    workspace:
      isObj(json) && isObj(json.workspace) ? space(json.workspace) : null,
    cases: list(json, 'cases', (r) => {
      const caseId = str(r.caseId);
      if (!caseId) return null;
      return {
        caseId,
        stage: str(r.stage) ?? '',
        product: str(r.product),
        agentId: str(r.agentId),
        coordinatorId: str(r.coordinatorId),
        openedAt: str(r.openedAt),
        closedAt: str(r.closedAt),
        contactId: str(r.contactId),
        contactName: str(r.contactName),
        slaState: str(r.slaState),
        nextDueAt: str(r.nextDueAt),
        isLead: r.isLead === true,
      };
    }),
  };
}

export type BankRole = 'admin' | 'team_lead' | 'coordinator' | 'agent';
export interface BankSummary {
  openCases: number;
  members: {
    agents: number;
    coordinators: number;
    teamLeads: number;
    total: number;
  };
  openActions: number;
  myRole: BankRole | null;
}
const ROLES: readonly string[] = ['admin', 'team_lead', 'coordinator', 'agent'];

/** GET /api/banks/[id]/summary; null when the body is unusable (the strip hides). */
export function parseBankSummary(json: unknown): BankSummary | null {
  if (!isObj(json) || !isObj(json.summary)) return null;
  const d = json.summary;
  const m = isObj(d.members) ? d.members : {};
  return {
    openCases: count(d.openCases),
    members: {
      agents: count(m.agents),
      coordinators: count(m.coordinators),
      teamLeads: count(m.teamLeads),
      total: count(m.total),
    },
    openActions: count(d.openActions),
    myRole: ROLES.includes(String(d.myRole)) ? (d.myRole as BankRole) : null,
  };
}

export type SlaTone = 'bad' | 'warn' | 'muted';
/**
 * The Cases tab's SLA chip: null for a closed case (nothing shown), else
 * Overdue (bad), Due soon (warn) or On track (muted). `key` is under
 * `Banks.cases.sla`.
 */
export function slaChip(
  c: Pick<BankCase, 'closedAt' | 'slaState'>
): { key: 'overdue' | 'dueSoon' | 'onTrack'; tone: SlaTone } | null {
  if (c.closedAt) return null;
  if (c.slaState === 'overdue') return { key: 'overdue', tone: 'bad' };
  if (c.slaState === 'due_soon') return { key: 'dueSoon', tone: 'warn' };
  return { key: 'onTrack', tone: 'muted' };
}

export const parseThreads = (json: unknown): BankThread[] =>
  list(json, 'threads', (r) => {
    const threadId = str(r.threadId);
    if (!threadId) return null;
    return {
      threadId,
      title: str(r.title) ?? '',
      authorId: str(r.authorId),
      createdAt: str(r.createdAt),
      caseId: str(r.caseId),
      taskId: str(r.taskId),
      postCount: count(r.postCount),
      actionOwnerId: str(r.actionOwnerId),
      actionDueAt: str(r.actionDueAt),
    };
  });

export const parsePosts = (json: unknown): BankPost[] =>
  list(json, 'posts', (r) => {
    const postId = str(r.postId);
    if (!postId) return null;
    const retracted = r.retracted === true;
    return {
      postId,
      parentPostId: str(r.parentPostId),
      authorId: str(r.authorId),
      // A retracted post never shows text, whatever the body says.
      body: retracted ? null : typeof r.body === 'string' ? r.body : null,
      retracted,
      caseId: str(r.caseId),
      caseReadable: r.caseReadable === true,
      caseStage: str(r.caseStage),
      caseProduct: str(r.caseProduct),
      createdAt: str(r.createdAt),
    };
  });

export const parsePins = (json: unknown): BankPin[] =>
  list(json, 'pins', (r) => {
    const pinId = str(r.pinId);
    const kind = (PIN_KINDS as readonly unknown[]).includes(r.kind)
      ? (r.kind as PinKind)
      : null;
    if (!pinId || !kind) return null;
    return {
      pinId,
      kind,
      body: typeof r.body === 'string' ? r.body : '',
      authorId: str(r.authorId),
      createdAt: str(r.createdAt),
    };
  });

export const parseActions = (json: unknown): BankAction[] =>
  list(json, 'actions', (r) => {
    const actionId = str(r.actionId);
    const threadId = str(r.threadId);
    if (!actionId || !threadId) return null;
    return {
      actionId,
      threadId,
      ownerId: str(r.ownerId),
      dueAt: str(r.dueAt),
      caseId: str(r.caseId),
      taskId: str(r.taskId),
      taskStatus: str(r.taskStatus),
    };
  });

const time = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};
const byTime = (a: BankPost, b: BankPost) =>
  time(a.createdAt) - time(b.createdAt);

export interface PostNode {
  post: BankPost;
  replies: BankPost[];
}

/**
 * Posts -> a conversation with one level of replies: roots in time order,
 * each with its replies in time order. A reply whose parent is itself a
 * reply hangs under that reply's root; one whose parent is missing shows
 * as a root rather than vanishing.
 */
export function threadTree(posts: readonly BankPost[]): PostNode[] {
  const byId = new Map(posts.map((p) => [p.postId, p]));
  const rootOf = (p: BankPost): BankPost => {
    let cur = p;
    const seen = new Set<string>();
    while (cur.parentPostId && !seen.has(cur.postId)) {
      seen.add(cur.postId);
      const parent = byId.get(cur.parentPostId);
      if (!parent) break;
      cur = parent;
    }
    return cur;
  };
  const nodes = new Map<string, PostNode>();
  const sorted = [...posts].sort(byTime);
  for (const p of sorted) {
    const root = rootOf(p);
    if (root.postId === p.postId) nodes.set(p.postId, { post: p, replies: [] });
  }
  for (const p of sorted) {
    const root = rootOf(p);
    if (root.postId !== p.postId) nodes.get(root.postId)?.replies.push(p);
  }
  return [...nodes.values()];
}

/** The latest version of each pin kind that is not blank. */
export function currentPins(pins: readonly BankPin[]): Map<PinKind, BankPin> {
  const out = new Map<PinKind, BankPin>();
  for (const p of pins) {
    const had = out.get(p.kind);
    if (!had || time(p.createdAt) >= time(had.createdAt)) out.set(p.kind, p);
  }
  for (const [k, p] of out) if (p.body.trim() === '') out.delete(k);
  return out;
}

export function isOverdue(dueAt: string | null, now: Date): boolean {
  const t = dueAt ? Date.parse(dueAt) : NaN;
  return Number.isFinite(t) && t < now.getTime();
}

/** A `datetime-local` value (local time) -> ISO, or null when unusable. */
export function localToIso(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The API's 422 codes -> a key under `Banks.errors`. */
export const ERROR_KEYS: Readonly<Record<string, string>> = {
  LINK_INVALID: 'linkInvalid',
  BODY_INVALID: 'bodyInvalid',
  TITLE_INVALID: 'titleInvalid',
  OWNER_INVALID: 'ownerInvalid',
  DUE_REQUIRED: 'dueRequired',
  DUE_INVALID: 'dueInvalid',
  ALREADY_MARKED: 'alreadyMarked',
  ALREADY_RETRACTED: 'alreadyRetracted',
  KIND_INVALID: 'kindInvalid',
  PARENT_INVALID: 'parentInvalid',
};

/** A failed response -> the `Banks.errors` key to show. */
export function errorKey(status: number, json: unknown): string {
  const code = isObj(json) ? str(json.code) : null;
  if (code && ERROR_KEYS[code]) return ERROR_KEYS[code];
  if (status === 403) return 'notAllowed';
  if (status === 404) return 'notFound';
  return 'failed';
}
