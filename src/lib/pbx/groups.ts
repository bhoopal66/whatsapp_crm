// ============================================================
// The ring groups and call queues panel's pure rules (Linkus-style).
// Client-safe: no I/O. The panel reads GET /api/pbx/groups and acts
// through POST /api/pbx/queues/{id}/agent; everything it decides about
// that payload lives here so it can be tested without a DOM.
//
// The payload is parsed defensively: an unknown shape is empty lists,
// an entry without an id or number is dropped, an unknown call status
// is 'unknown'. A static agent is always in the queue, so it is never
// offered Log in / Log out; Pause / Resume needs a logged-in agent.
// ============================================================

export const CALL_STATUSES = [
  'unknown',
  'idle',
  'in_call',
  'ringing',
  'waiting',
  'on_hold',
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export type QueueAction = 'login' | 'logout' | 'pause' | 'unpause';

export interface GroupMember {
  extension: string;
  userId: string | null;
  name: string | null;
}

export interface RingGroupView {
  id: number;
  number: string;
  name: string;
  strategy: string;
  members: GroupMember[];
}

export interface QueueAgent extends GroupMember {
  static: boolean;
  loggedIn: boolean;
  paused: boolean;
  callStatus: CallStatus;
}

export interface QueueView {
  id: number;
  number: string;
  name: string;
  agents: QueueAgent[];
}

export interface GroupsPayload {
  myExtension: string | null;
  canManage: boolean;
  ringGroups: RingGroupView[];
  queues: QueueView[];
  queuesTruncated: boolean;
}

export const EMPTY_GROUPS: GroupsPayload = {
  myExtension: null,
  canManage: false,
  ringGroups: [],
  queues: [],
  queuesTruncated: false,
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isId = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v);

function parseMember(v: unknown): GroupMember | null {
  if (!isObj(v)) return null;
  const extension = str(v.extension);
  if (!extension) return null;
  return { extension, userId: str(v.userId), name: str(v.name) };
}

function parseAgent(v: unknown): QueueAgent | null {
  const m = parseMember(v);
  if (!m || !isObj(v)) return null;
  const status = (CALL_STATUSES as readonly unknown[]).includes(v.callStatus)
    ? (v.callStatus as CallStatus)
    : 'unknown';
  return {
    ...m,
    static: v.static === true,
    loggedIn: v.loggedIn === true,
    paused: v.paused === true,
    callStatus: status,
  };
}

const present = <T>(x: T | null): x is T => x !== null;

/** GET /api/pbx/groups, whatever came back. */
export function parseGroupsPayload(raw: unknown): GroupsPayload {
  if (!isObj(raw)) return EMPTY_GROUPS;
  const ringGroups = list(raw.ringGroups).flatMap((g): RingGroupView[] => {
    if (!isObj(g) || !isId(g.id)) return [];
    const number = str(g.number);
    if (!number) return [];
    return [
      {
        id: g.id,
        number,
        name: str(g.name) ?? number,
        strategy: str(g.strategy) ?? '',
        members: list(g.members).map(parseMember).filter(present),
      },
    ];
  });
  const queues = list(raw.queues).flatMap((q): QueueView[] => {
    if (!isObj(q) || !isId(q.id)) return [];
    const number = str(q.number);
    if (!number) return [];
    return [
      {
        id: q.id,
        number,
        name: str(q.name) ?? number,
        agents: list(q.agents).map(parseAgent).filter(present),
      },
    ];
  });
  return {
    myExtension: str(raw.myExtension),
    canManage: raw.canManage === true,
    ringGroups,
    queues,
    queuesTruncated: raw.queuesTruncated === true,
  };
}

export const isEmptyGroups = (p: GroupsPayload): boolean =>
  p.ringGroups.length === 0 && p.queues.length === 0;

export type Tone = 'green' | 'amber' | 'red' | 'blue' | 'muted';

/** A PbxGroups message key and a chip colour. */
export interface Chip {
  key: string;
  tone: Tone;
}

const STATUS_CHIPS: Record<CallStatus, Chip> = {
  unknown: { key: 'statusUnknown', tone: 'muted' },
  idle: { key: 'statusIdle', tone: 'green' },
  in_call: { key: 'statusInCall', tone: 'red' },
  ringing: { key: 'statusRinging', tone: 'blue' },
  waiting: { key: 'statusWaiting', tone: 'red' },
  on_hold: { key: 'statusOnHold', tone: 'amber' },
};

export const callStatusChip = (s: CallStatus): Chip => STATUS_CHIPS[s];

export type AgentState =
  'offline' | 'ringing' | 'on_call' | 'paused' | 'available';

/** What a queue agent is doing; a live call outranks a pause. */
export function agentState(a: QueueAgent): AgentState {
  if (!a.loggedIn) return 'offline';
  if (a.callStatus === 'ringing') return 'ringing';
  if (
    a.callStatus === 'in_call' ||
    a.callStatus === 'waiting' ||
    a.callStatus === 'on_hold'
  )
    return 'on_call';
  if (a.paused) return 'paused';
  return 'available';
}

/** The agent's chip: on a call it names the call's status (on hold, …). */
export function agentChip(a: QueueAgent): Chip {
  switch (agentState(a)) {
    case 'offline':
      return { key: 'stateOffline', tone: 'muted' };
    case 'paused':
      return { key: 'statePaused', tone: 'amber' };
    case 'available':
      return { key: 'stateAvailable', tone: 'green' };
    default:
      return callStatusChip(a.callStatus);
  }
}

function actionsFor(a: Pick<QueueAgent, 'static' | 'loggedIn' | 'paused'>) {
  const out: QueueAction[] = [];
  if (!a.static) out.push(a.loggedIn ? 'logout' : 'login');
  if (a.loggedIn) out.push(a.paused ? 'unpause' : 'pause');
  return out;
}

export interface MyQueueState {
  member: boolean;
  static: boolean;
  loggedIn: boolean;
  paused: boolean;
  actions: QueueAction[];
}

/** The caller's own place in a queue and the buttons it offers. */
export function myQueueState(
  queue: QueueView,
  myExtension: string | null
): MyQueueState {
  const me = myExtension
    ? queue.agents.find((a) => a.extension === myExtension)
    : undefined;
  if (!me)
    return {
      member: false,
      static: false,
      loggedIn: false,
      paused: false,
      actions: [],
    };
  return {
    member: true,
    static: me.static,
    loggedIn: me.loggedIn,
    paused: me.paused,
    actions: actionsFor(me),
  };
}

/**
 * A manager's buttons on someone's row. The caller's own row offers
 * none: their controls sit once on the queue (myQueueState) and post
 * without an extension.
 */
export function agentActions(
  agent: QueueAgent,
  { canManage, isMe }: { canManage: boolean; isMe: boolean }
): QueueAction[] {
  // No userId: another workspace's extension on a shared PBX, which the
  // server refuses (404) for every manager action.
  if (isMe || !canManage || agent.userId === null) return [];
  return actionsFor(agent);
}

/** The button label key for an action. */
export const ACTION_KEYS: Record<QueueAction, string> = {
  login: 'logIn',
  logout: 'logOut',
  pause: 'pause',
  unpause: 'resume',
};

/** A name, else "Ext 123" (the caller supplies the wording). */
export function displayName(
  m: Pick<GroupMember, 'name' | 'extension'>,
  ext: (extension: string) => string = (e) => `Ext ${e}`
): string {
  return m.name?.trim() || ext(m.extension);
}

/** Me first, then by name (nameless by extension), numbers in order. */
export function sortAgents<T extends GroupMember>(
  agents: readonly T[],
  myExtension: string | null
): T[] {
  const key = (a: T) => a.name?.trim() || a.extension;
  return [...agents].sort((a, b) => {
    const am = myExtension !== null && a.extension === myExtension;
    const bm = myExtension !== null && b.extension === myExtension;
    if (am !== bm) return am ? -1 : 1;
    return (
      key(a).localeCompare(key(b), undefined, {
        numeric: true,
        sensitivity: 'base',
      }) || a.extension.localeCompare(b.extension, undefined, { numeric: true })
    );
  });
}

const STRATEGY_KEYS: Record<string, string> = {
  ring_all: 'strategyRingAll',
  sequentially: 'strategySequentially',
  memory_hunt: 'strategyMemoryHunt',
  custom: 'strategyCustom',
};

/** A known ring strategy's message key; null shows the raw value. */
export const strategyKey = (s: string): string | null =>
  Object.hasOwn(STRATEGY_KEYS, s) ? STRATEGY_KEYS[s] : null;

/** The `error` of an `{ error }` body, if any. */
export const errorCode = (body: unknown): string | null =>
  isObj(body) ? str(body.error) : null;

const ACTION_ERROR_KEYS: Record<string, string> = {
  static_agent: 'errStaticAgent',
  not_in_queue: 'errNotInQueue',
  queue_not_found: 'errQueueNotFound',
  no_extension: 'errNoExtension',
};

/** A friendly message key for a failed queue action. */
export const actionErrorKey = (code: string | null): string =>
  code && Object.hasOwn(ACTION_ERROR_KEYS, code)
    ? ACTION_ERROR_KEYS[code]
    : 'errAction';

/** A friendly message key for a failed load. */
export const loadErrorKey = (code: string | null): string =>
  code === 'no_extension' ? 'loadNoExtension' : 'loadFailed';

/** Every message key the helpers above can return. */
export const GROUPS_MESSAGE_KEYS: readonly string[] = [
  ...Object.values(STATUS_CHIPS).map((c) => c.key),
  'stateOffline',
  'statePaused',
  'stateAvailable',
  ...Object.values(ACTION_KEYS),
  ...Object.values(STRATEGY_KEYS),
  ...Object.values(ACTION_ERROR_KEYS),
  'errAction',
  'loadNoExtension',
  'loadFailed',
];
