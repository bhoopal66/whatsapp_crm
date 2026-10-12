import { YeastarError } from './errors';
import type { YeastarClient } from './client';

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

export interface YeastarApi {
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
 * without a channel id cannot be acted on, so it is dropped.
 */
function parseMembers(raw: unknown): CallMember[] {
  const out: CallMember[] = [];
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    for (const kind of MEMBER_KINDS) {
      const m = entry[kind];
      const channelId = isRecord(m) ? nonEmpty(m.channel_id) : undefined;
      if (!isRecord(m) || !channelId) continue;
      const callPath = nonEmpty(m.call_path);
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
  return {
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
  };
}
