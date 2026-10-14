import { YeastarError } from './errors';
import type { YeastarClient } from './client';
import type { PresenceStatus } from './events';

/** `cdr/search` refuses pages above this ("Maximum value: 10,000"). */
export const CDR_MAX_PAGE_SIZE = 10_000;

export interface DialInput {
  caller: string;
  callee: string;
  /** Sent as `auto_answer: yes|no`; only honoured by phones that support it. */
  autoAnswer?: boolean;
  /** An extension whose dial permission the call borrows. */
  dialPermission?: string;
}

export interface ChannelInput {
  /** From `queryCalls` or the (30011) Call State Changed event. */
  channelId: string;
}

export type TransferType = 'blind' | 'attended';
export type AttendedOperate = 'abort' | 'complete' | 'threeway' | 'swap';

/**
 * Blind: `channelId` is the member being moved. Attended: the transferor's;
 * call once with `number` to start it, again with `attendedOperate` to
 * finish it. The docs call `dialPermission` optional in the table but
 * required in the note for blind and for starting an attended transfer,
 * and their blind example omits it: it is passed through untouched and the
 * PBX decides.
 */
export interface TransferInput {
  type: TransferType;
  channelId: string;
  number?: string;
  attendedOperate?: AttendedOperate;
  dialPermission?: string;
}

/** Exactly one selector; the PBX documents no behaviour for two. */
export type CallQuery =
  | { callId: string; type?: never; extension?: never }
  | {
      type: 'inbound' | 'outbound' | 'internal';
      callId?: never;
      extension?: never;
    }
  | { extension: string; callId?: never; type?: never };

export type CallMemberKind = 'extension' | 'inbound' | 'outbound';

export interface CallMember {
  kind: CallMemberKind;
  channelId: string;
  /** ALERT, RING, ANSWERED, ANSWER, HOLD or BYE; unknown values pass through. */
  status: string;
  /** Only set when the call went through an IVR, queue, ring group, ... */
  callPath?: string;
  /** Extension members. */
  number?: string;
  /** Trunk members. */
  from?: string;
  to?: string;
  trunkName?: string;
}

export interface CallInfo {
  callId: string;
  members: CallMember[];
}

export interface ExtensionOnline {
  sipPhone: boolean;
  linkusDesktop: boolean;
  linkusMobile: boolean;
  linkusWeb: boolean;
}

export interface ExtensionSummary {
  /** The PBX's own id, which `extension/update` takes; not the number. */
  id?: number;
  number: string;
  callerIdName: string;
  email?: string;
  presenceStatus?: string;
  online: ExtensionOnline;
}

export interface ExtensionList {
  total: number;
  items: ExtensionSummary[];
}

export interface SetPresenceInput {
  /** The PBX's extension id (`findExtension`), not the number. */
  id: number;
  status: PresenceStatus;
}

/** `extension/search` pages read before giving up on an exact number. */
const SEARCH_PAGE_SIZE = 100;
const SEARCH_MAX_PAGES = 20;

/** A CDR row exactly as the PBX sent it; legacy and new rows differ. */
export type CdrRecord = Record<string, unknown>;

export interface CdrSearchInput {
  startTime: Date;
  endTime: Date;
  /** 1-based. */
  page?: number;
  /** 1 to {@link CDR_MAX_PAGE_SIZE}. */
  pageSize?: number;
}

export interface CdrSearchResult {
  total: number;
  records: CdrRecord[];
}

export type RecordingRef =
  { id: number; file?: never } | { file: string; id?: never };

export interface YeastarApi extends VoicemailApi {
  /** Starts a call; the only thing the PBX returns is its `call_id`. */
  dial(input: DialInput): Promise<{ callId: string }>;
  hangup(input: ChannelInput): Promise<void>;
  transfer(input: TransferInput): Promise<void>;
  queryCalls(query: CallQuery): Promise<CallInfo[]>;
  hold(input: ChannelInput): Promise<void>;
  unhold(input: ChannelInput): Promise<void>;
  mute(input: ChannelInput): Promise<void>;
  unmute(input: ChannelInput): Promise<void>;
  listExtensions(options?: {
    page?: number;
    pageSize?: number;
  }): Promise<ExtensionList>;
  /**
   * v1 `extension/search` for one number. `search_value` is a keyword
   * matched loosely (200 also finds 2000, names and emails), so results
   * are paged and only an exact `number` with an id counts.
   */
  findExtension(
    number: string
  ): Promise<(ExtensionSummary & { id: number }) | null>;
  /** v1 `extension/update` with `presence_status` only. */
  setPresence(input: SetPresenceInput): Promise<void>;
  /**
   * v1 `cdr/search`. The window goes out as Unix seconds, the one time
   * format the docs allow that does not depend on the PBX's display format
   * (a wrong format silently returns no records).
   */
  searchCdr(input: CdrSearchInput): Promise<CdrSearchResult>;
  /**
   * Two steps behind one call: ask for the download path, then join it to
   * the base URL with a token. The URL lives 30 minutes and embeds a live
   * token: fetch it server-side, never send it to a browser or a log.
   */
  recordingDownloadUrl(ref: RecordingRef): Promise<string>;
  /** Token, API switch and extension-list permission in one cheap call. */
  testConnection(): Promise<{ ok: true; extensionCount: number }>;
}

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;

function invalidResponse(endpoint: string, detail: string): YeastarError {
  return new YeastarError({
    endpoint,
    errcode: null,
    errmsg: 'INVALID RESPONSE',
    detail,
  });
}

/** An empty result may omit `data`; a `data` that is not a list is a fault. */
function dataArray(endpoint: string, res: Json): unknown[] {
  if (res.data === undefined) return [];
  if (!Array.isArray(res.data)) {
    throw invalidResponse(endpoint, 'data is not an array');
  }
  return res.data;
}

function totalNumber(endpoint: string, res: Json): number {
  const n = res.total_number;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw invalidResponse(endpoint, 'total_number missing');
  }
  return n;
}

const MEMBER_KINDS: readonly CallMemberKind[] = [
  'extension',
  'inbound',
  'outbound',
];

/**
 * Each entry of `members` is an object keyed by what the leg is. A leg
 * without a channel id cannot be acted on, so it is dropped. Shared by
 * `call/query` and the (30011) Call State Changed event. The docs' own
 * samples send `call_path: " "` for a call that took no IVR, queue or
 * ring group, so a blank path counts as none.
 */
export function parseMembers(raw: unknown): CallMember[] {
  const out: CallMember[] = [];
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    for (const kind of MEMBER_KINDS) {
      const m = entry[kind];
      const channelId = isRecord(m) ? nonEmpty(m.channel_id) : undefined;
      if (!isRecord(m) || !channelId) continue;
      const callPath =
        typeof m.call_path === 'string' && m.call_path.trim() !== ''
          ? m.call_path
          : undefined;
      const num = nonEmpty(m.number);
      const from = nonEmpty(m.from);
      const to = nonEmpty(m.to);
      const trunkName = nonEmpty(m.trunk_name);
      out.push({
        kind,
        channelId,
        status: typeof m.member_status === 'string' ? m.member_status : '',
        ...(callPath ? { callPath } : {}),
        ...(num ? { number: num } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(trunkName ? { trunkName } : {}),
      });
    }
  }
  return out;
}

/**
 * A SIP phone's registration is only in `status_list[].status`: the
 * docs' own example shows `sip_phone.status: 0` for a phone that is
 * registered. The Linkus clients use the plain `status`.
 */
const sipOnline = (endpoint: unknown): boolean =>
  isRecord(endpoint) &&
  Array.isArray(endpoint.status_list) &&
  endpoint.status_list.some((s) => isRecord(s) && s.status === 1);

const linkusOnline = (endpoint: unknown): boolean =>
  isRecord(endpoint) && endpoint.status === 1;

function parseExtension(raw: unknown): ExtensionSummary | null {
  if (!isRecord(raw)) return null;
  const num = nonEmpty(raw.number);
  if (!num) return null;
  const status = isRecord(raw.online_status) ? raw.online_status : {};
  const email = nonEmpty(raw.email_addr);
  const presenceStatus = nonEmpty(raw.presence_status);
  const id =
    typeof raw.id === 'number' && Number.isInteger(raw.id) ? raw.id : undefined;
  return {
    ...(id !== undefined ? { id } : {}),
    number: num,
    callerIdName:
      typeof raw.caller_id_name === 'string' ? raw.caller_id_name : '',
    ...(email ? { email } : {}),
    ...(presenceStatus ? { presenceStatus } : {}),
    online: {
      sipPhone: sipOnline(status.sip_phone),
      linkusDesktop: linkusOnline(status.linkus_desktop),
      linkusMobile: linkusOnline(status.linkus_mobile),
      linkusWeb: linkusOnline(status.linkus_web),
    },
  };
}

function unixSeconds(name: string, d: Date): number {
  const ms = d.getTime();
  if (!Number.isFinite(ms)) throw new RangeError(`${name} is not a valid Date`);
  return Math.floor(ms / 1000);
}

export function createYeastarApi(client: YeastarClient): YeastarApi {
  const channelCall =
    (endpoint: string) =>
    async ({ channelId }: ChannelInput): Promise<void> => {
      await client.request('POST', endpoint, {
        body: { channel_id: channelId },
      });
    };

  async function listExtensions({
    page,
    pageSize,
  }: { page?: number; pageSize?: number } = {}): Promise<ExtensionList> {
    const endpoint = 'extension/list';
    const res = await client.request('GET', endpoint, {
      query: { page, page_size: pageSize },
    });
    return {
      total: totalNumber(endpoint, res),
      items: dataArray(endpoint, res)
        .map(parseExtension)
        .filter((e): e is ExtensionSummary => e !== null),
    };
  }

  return {
    ...createQueueApi(client),
    async dial({ caller, callee, autoAnswer, dialPermission }) {
      const body: Record<string, string> = { caller, callee };
      if (dialPermission !== undefined) body.dial_permission = dialPermission;
      if (autoAnswer !== undefined) {
        body.auto_answer = autoAnswer ? 'yes' : 'no';
      }
      const res = await client.request('POST', 'call/dial', { body });
      const callId = nonEmpty(res.call_id);
      if (!callId) throw invalidResponse('call/dial', 'call_id missing');
      return { callId };
    },

    hangup: channelCall('call/hangup'),
    hold: channelCall('call/hold'),
    unhold: channelCall('call/unhold'),
    mute: channelCall('call/mute'),
    unmute: channelCall('call/unmute'),

    async transfer({
      type,
      channelId,
      number,
      attendedOperate,
      dialPermission,
    }) {
      const body: Record<string, string> = { type, channel_id: channelId };
      if (number !== undefined) body.number = number;
      if (dialPermission !== undefined) body.dial_permission = dialPermission;
      if (attendedOperate !== undefined) {
        body.attended_operate = attendedOperate;
      }
      await client.request('POST', 'call/transfer', { body });
    },

    async queryCalls(q) {
      const chosen = [q.callId, q.type, q.extension].filter(
        (v) => v !== undefined
      );
      if (chosen.length !== 1) {
        throw new TypeError(
          'queryCalls needs exactly one of callId, type or extension'
        );
      }
      const query =
        q.callId !== undefined
          ? { call_id: q.callId }
          : q.type !== undefined
            ? { type: q.type }
            : { extension: q.extension };
      const endpoint = 'call/query';
      const res = await client.request('GET', endpoint, { query });
      const calls: CallInfo[] = [];
      for (const raw of dataArray(endpoint, res)) {
        const callId = isRecord(raw) ? nonEmpty(raw.call_id) : undefined;
        if (!isRecord(raw) || !callId) continue;
        calls.push({ callId, members: parseMembers(raw.members) });
      }
      return calls;
    },

    listExtensions,

    async findExtension(number) {
      const endpoint = 'extension/search';
      for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
        const res = await client.request('GET', endpoint, {
          query: { search_value: number, page, page_size: SEARCH_PAGE_SIZE },
        });
        const rows = dataArray(endpoint, res);
        for (const e of rows.map(parseExtension)) {
          if (e?.number === number && e.id !== undefined)
            return { ...e, id: e.id };
        }
        const total =
          typeof res.total_number === 'number' ? res.total_number : 0;
        if (rows.length === 0 || page * SEARCH_PAGE_SIZE >= total) break;
      }
      return null;
    },

    async setPresence({ id, status }) {
      await client.request('POST', 'extension/update', {
        body: { id, presence_status: status },
      });
    },

    async searchCdr({ startTime, endTime, page, pageSize }) {
      if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
        throw new RangeError('page must be a positive integer');
      }
      if (
        pageSize !== undefined &&
        (!Number.isInteger(pageSize) ||
          pageSize < 1 ||
          pageSize > CDR_MAX_PAGE_SIZE)
      ) {
        throw new RangeError(
          `pageSize must be an integer from 1 to ${CDR_MAX_PAGE_SIZE}`
        );
      }
      const endpoint = 'cdr/search';
      const res = await client.request('GET', endpoint, {
        query: {
          start_time: unixSeconds('startTime', startTime),
          end_time: unixSeconds('endTime', endTime),
          page,
          page_size: pageSize,
        },
      });
      return {
        total: totalNumber(endpoint, res),
        records: dataArray(endpoint, res).filter(isRecord),
      };
    },

    async recordingDownloadUrl(ref) {
      if ((ref.id === undefined) === (ref.file === undefined)) {
        throw new TypeError(
          'recordingDownloadUrl needs exactly one of id or file'
        );
      }
      const endpoint = 'recording/download';
      const res = await client.request('GET', endpoint, {
        query: ref.id !== undefined ? { id: ref.id } : { file: ref.file },
      });
      // Already starts with "/api/..."; resourceUrl joins without doubling.
      const path = nonEmpty(res.download_resource_url);
      if (!path)
        throw invalidResponse(endpoint, 'download_resource_url missing');
      return client.resourceUrl(path);
    },

    async testConnection() {
      const { total } = await listExtensions({ page: 1, pageSize: 1 });
      return { ok: true as const, extensionCount: total };
    },

    ...createVoicemailApi(client),
  };
}

// ---------- Voicemail (vm/get, vm/download, vm/update, vm/delete) ----------

/** One message as `vm/get` lists it; `time` is the PBX's display string. */
export interface VoicemailMessage {
  msgId: string;
  /** "msg0000.wav": its extension names the audio format. */
  fileName: string;
  read: boolean;
  callerName: string;
  callerNumber: string;
  /** Wall-clock time in the PBX's zone and display format (parsePbxTime). */
  time: string;
  durationSeconds: number;
}

export interface VoicemailList {
  total: number;
  items: VoicemailMessage[];
}

export interface VoicemailRef {
  /** `msg_id` from `vm/get`; the other endpoints call it `id`. */
  msgId: string;
}

export interface VoicemailApi {
  /** v1 `vm/get` for one extension (or a shared group voicemail). */
  listVoicemail(input: {
    number: string;
    /** 1-based. */
    page?: number;
    pageSize?: number;
  }): Promise<VoicemailList>;
  /**
   * `vm/download`, joined to the base URL with a token, as
   * {@link YeastarApi.recordingDownloadUrl}: valid 30 minutes and embeds
   * a live token. Fetch it server-side; never send it to a browser or a
   * log.
   */
  voicemailDownloadUrl(ref: VoicemailRef): Promise<string>;
  /** `vm/update` with `vm_status: 1`, the only status the PBX accepts. */
  markVoicemailRead(ref: VoicemailRef): Promise<void>;
  /** `vm/delete` (a GET, `id` in the query). */
  deleteVoicemail(ref: VoicemailRef): Promise<void>;
}

const textOf = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

function parseVoicemail(raw: unknown): VoicemailMessage | null {
  if (!isRecord(raw)) return null;
  const msgId = nonEmpty(raw.msg_id);
  if (!msgId) return null;
  const duration = Number(raw.duration);
  return {
    msgId,
    fileName: textOf(raw.file_name),
    read: Number(raw.is_read) === 1,
    callerName: textOf(raw.name),
    callerNumber: textOf(raw.number),
    time: textOf(raw.time),
    durationSeconds:
      Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
  };
}

function createVoicemailApi(client: YeastarClient): VoicemailApi {
  const refId = (name: string, ref: VoicemailRef): string => {
    if (!nonEmpty(ref?.msgId)) throw new TypeError(`${name} needs a msgId`);
    return ref.msgId;
  };
  return {
    async listVoicemail({ number, page, pageSize }) {
      if (!nonEmpty(number))
        throw new TypeError('listVoicemail needs a number');
      const endpoint = 'vm/get';
      const res = await client.request('GET', endpoint, {
        query: { number, page, page_size: pageSize },
      });
      const items = dataArray(endpoint, res)
        .map(parseVoicemail)
        .filter((m): m is VoicemailMessage => m !== null);
      // An empty box may answer without total_number.
      const total =
        typeof res.total_number === 'number' &&
        Number.isFinite(res.total_number)
          ? res.total_number
          : items.length;
      return { total, items };
    },

    async voicemailDownloadUrl(ref) {
      const msgId = refId('voicemailDownloadUrl', ref);
      const endpoint = 'vm/download';
      const res = await client.request('GET', endpoint, {
        query: { msg_id: msgId },
      });
      const path = nonEmpty(res.download_resource_url);
      if (!path)
        throw invalidResponse(endpoint, 'download_resource_url missing');
      return client.resourceUrl(path);
    },

    async markVoicemailRead(ref) {
      const id = refId('markVoicemailRead', ref);
      await client.request('POST', 'vm/update', {
        body: { id, vm_status: 1 },
      });
    },

    async deleteVoicemail(ref) {
      const id = refId('deleteVoicemail', ref);
      await client.request('GET', 'vm/delete', { query: { id } });
    },
  };
}

// ---------- Ring groups, queues and agents ----------
// One block, kept apart from the call-control methods above; the
// interface below merges into YeastarApi. Every parameter here is one
// the Yeastar P-Series developer guide documents. `reason` (a pause
// reason's feature code) is never sent: on a plan below Enterprise /
// Ultimate the PBX fails the whole request when it is present.

/** A ring group member that is one extension (`type: extension`). */
export interface RingGroupMember {
  /** `text2`: the extension number. */
  number: string;
  /** `text`: the PBX's full name for it. */
  name: string;
}

export interface RingGroup {
  id: number;
  number: string;
  name: string;
  /** ring_all, sequentially, memory_hunt or custom. */
  strategy: string;
  /**
   * Extension members only: extension groups and external numbers are
   * left out. A custom strategy nests its members in `sub_option`.
   */
  members: RingGroupMember[];
}

export interface QueueMember {
  /** `value`: the PBX's extension id, which agent/* calls take. */
  extId?: number;
  /** `text2`: the extension number. */
  number: string;
  name: string;
}

export interface QueueInfo {
  id: number;
  number: string;
  name: string;
  strategy: string;
  dynamicAgents: QueueMember[];
  staticAgents: QueueMember[];
}

export interface QueueAgentStatus {
  number: string;
  name: string;
  loggedIn: boolean;
  paused: boolean;
  /**
   * 0 unknown, 1 idle, 2 in a call, 3 ringing, 4 a new call during a
   * call, 5 on hold by the caller (an agent's own hold reads 2).
   */
  callStatus: number;
  pauseReason: string;
  /** dynamic or static; a static agent cannot log in or out. */
  agentType: string;
}

export type AgentLoginOperation = 'login' | 'logout';
export type AgentPauseOperation = 'pause' | 'unpause';

/** agent/login and agent/pause: one agent; no queue ids means all its queues. */
export interface AgentSelfInput<Op> {
  extId: number;
  operation: Op;
  queueIds?: number[];
}

/** queue/agent_login and queue/agent_pause: agents of one queue. */
export interface QueueAgentsInput<Op> {
  extIds: number[];
  queueId: number;
  operation: Op;
}

export interface YeastarApi {
  /** `ringgroup/list` (paged), then `ringgroup/query` for the members. */
  listRingGroups(): Promise<RingGroup[]>;
  /** `queue/list` (paged); it carries the agent lists itself. */
  listQueues(): Promise<QueueInfo[]>;
  /** `queue/agent_status?id=`. */
  queueAgentStatus(queueId: number): Promise<QueueAgentStatus[]>;
  /** `agent/login`: a dynamic agent logs itself in or out. */
  agentLogin(input: AgentSelfInput<AgentLoginOperation>): Promise<void>;
  /** `agent/pause`: an agent pauses or resumes its own queue service. */
  agentPause(input: AgentSelfInput<AgentPauseOperation>): Promise<void>;
  /** `queue/agent_login`: log other dynamic agents in or out of a queue. */
  managerAgentLogin(
    input: QueueAgentsInput<AgentLoginOperation>
  ): Promise<void>;
  /** `queue/agent_pause`: pause or resume other agents in a queue. */
  managerAgentPause(
    input: QueueAgentsInput<AgentPauseOperation>
  ): Promise<void>;
}

/** List pages read before stopping; 100 per page. */
const GROUP_PAGE_SIZE = 100;
const GROUP_MAX_PAGES = 20;
/** Ring group ids per `ringgroup/query` call. */
const RINGGROUP_QUERY_CHUNK = 50;

const intId = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
};

function positiveIds(name: string, ids: readonly number[]): string {
  if (!ids.length || !ids.every((n) => Number.isInteger(n) && n > 0)) {
    throw new RangeError(`${name} must be positive integers`);
  }
  return ids.join(',');
}

function ringGroupMembers(raw: unknown, out: RingGroupMember[]): void {
  if (!Array.isArray(raw)) return;
  for (const m of raw) {
    if (!isRecord(m)) continue;
    if (Array.isArray(m.sub_option)) ringGroupMembers(m.sub_option, out);
    const number = nonEmpty(m.text2);
    if (m.type !== 'extension' || !number) continue;
    if (out.some((x) => x.number === number)) continue;
    out.push({ number, name: typeof m.text === 'string' ? m.text : '' });
  }
}

function queueMembers(raw: unknown): QueueMember[] {
  if (!Array.isArray(raw)) return [];
  const out: QueueMember[] = [];
  for (const m of raw) {
    const number = isRecord(m) ? nonEmpty(m.text2) : undefined;
    if (!isRecord(m) || !number) continue;
    const extId = intId(m.value);
    out.push({
      ...(extId !== undefined ? { extId } : {}),
      number,
      name: typeof m.text === 'string' ? m.text : '',
    });
  }
  return out;
}

function createQueueApi(
  client: YeastarClient
): Pick<
  YeastarApi,
  | 'listRingGroups'
  | 'listQueues'
  | 'queueAgentStatus'
  | 'agentLogin'
  | 'agentPause'
  | 'managerAgentLogin'
  | 'managerAgentPause'
> {
  /** Every row of a paged list; `key` is where its rows are. */
  async function allPages(endpoint: string, key: string): Promise<Json[]> {
    const rows: Json[] = [];
    for (let page = 1; page <= GROUP_MAX_PAGES; page++) {
      const res = await client.request('GET', endpoint, {
        query: { page, page_size: GROUP_PAGE_SIZE },
      });
      const raw = res[key];
      if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
        throw invalidResponse(endpoint, `${key} is not an array`);
      }
      const batch = (raw ?? []) as unknown[];
      rows.push(...batch.filter(isRecord));
      const total = typeof res.total_number === 'number' ? res.total_number : 0;
      if (batch.length === 0 || page * GROUP_PAGE_SIZE >= total) break;
    }
    return rows;
  }

  const selfCall =
    (endpoint: string) =>
    async ({ extId, operation, queueIds }: AgentSelfInput<string>) => {
      positiveIds('extId', [extId]);
      await client.request('GET', endpoint, {
        query: {
          ext_id: extId,
          operation,
          queue_ids: queueIds?.length
            ? positiveIds('queueIds', queueIds)
            : undefined,
        },
      });
    };

  const managerCall =
    (endpoint: string) =>
    async ({ extIds, queueId, operation }: QueueAgentsInput<string>) => {
      positiveIds('queueId', [queueId]);
      await client.request('GET', endpoint, {
        query: {
          ext_ids: positiveIds('extIds', extIds),
          queue_id: queueId,
          operation,
        },
      });
    };

  return {
    async listRingGroups() {
      const list = await allPages('ringgroup/list', 'data');
      const ids = list
        .map((r) => intId(r.id))
        .filter((n): n is number => n !== undefined);
      const out: RingGroup[] = [];
      const endpoint = 'ringgroup/query';
      for (let i = 0; i < ids.length; i += RINGGROUP_QUERY_CHUNK) {
        const res = await client.request('GET', endpoint, {
          query: { ids: ids.slice(i, i + RINGGROUP_QUERY_CHUNK).join(',') },
        });
        for (const r of dataArray(endpoint, res)) {
          const id = isRecord(r) ? intId(r.id) : undefined;
          const number = isRecord(r) ? nonEmpty(r.number) : undefined;
          if (!isRecord(r) || id === undefined || !number) continue;
          const members: RingGroupMember[] = [];
          ringGroupMembers(r.member_list, members);
          out.push({
            id,
            number,
            name: typeof r.name === 'string' ? r.name : '',
            strategy:
              typeof r.ring_strategy === 'string' ? r.ring_strategy : '',
            members,
          });
        }
      }
      return out;
    },

    async listQueues() {
      const out: QueueInfo[] = [];
      for (const r of await allPages('queue/list', 'queue_list')) {
        const id = intId(r.id);
        const number = nonEmpty(r.number);
        if (id === undefined || !number) continue;
        out.push({
          id,
          number,
          name: typeof r.name === 'string' ? r.name : '',
          strategy: typeof r.ring_strategy === 'string' ? r.ring_strategy : '',
          dynamicAgents: queueMembers(r.dynamic_agent_list),
          staticAgents: queueMembers(r.static_agent_list),
        });
      }
      return out;
    },

    async queueAgentStatus(queueId) {
      positiveIds('queueId', [queueId]);
      const endpoint = 'queue/agent_status';
      const res = await client.request('GET', endpoint, {
        query: { id: queueId },
      });
      const out: QueueAgentStatus[] = [];
      for (const a of dataArray(endpoint, res)) {
        const number = isRecord(a) ? nonEmpty(a.number) : undefined;
        if (!isRecord(a) || !number) continue;
        out.push({
          number,
          name: typeof a.name === 'string' ? a.name : '',
          loggedIn: a.is_login === 1,
          paused: a.is_pause === 1,
          callStatus:
            typeof a.call_status === 'number' && Number.isInteger(a.call_status)
              ? a.call_status
              : 0,
          pauseReason: typeof a.pause_reason === 'string' ? a.pause_reason : '',
          agentType: typeof a.agent_type === 'string' ? a.agent_type : '',
        });
      }
      return out;
    },

    agentLogin: selfCall('agent/login'),
    agentPause: selfCall('agent/pause'),
    managerAgentLogin: managerCall('queue/agent_login'),
    managerAgentPause: managerCall('queue/agent_pause'),
  };
}
