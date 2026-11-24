/**
 * The details a message row does not carry (its files, reactions, reply
 * summary and cards), read apart from it: each kind settles alone, and
 * one that failed is read again by itself, for the messages it failed
 * for (`CachedTimeline.missing`). Framework-free: the timeline hook and
 * the thread store drive it.
 */
import {
  applyTimelineDetails,
  beginTimelineFetch,
  DETAIL_KINDS,
  timelineMark,
  type CachedTimeline,
  type DetailKind,
  type TimelineDetails,
} from './timeline-cache';

/** When a failed kind is read again; after that, on the next catch-up. */
export const DETAIL_RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;

/** The ids go in the URL: no more of them at once. */
export const DETAIL_IDS_MAX = 200;

export type ReadDetail = <K extends DetailKind>(
  kind: K,
  ids: string[]
) => Promise<TimelineDetails[K]>;

export function createDetailLoader({
  read,
  get,
  patch,
  kinds = DETAIL_KINDS,
}: {
  read: ReadDetail;
  get: () => CachedTimeline | undefined;
  patch: (fn: (e: CachedTimeline) => CachedTimeline) => void;
  kinds?: readonly DetailKind[];
}) {
  let shown = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** False when some kind was not read. Never rejects. */
  async function fetch(
    ids: string[],
    wanted: readonly DetailKind[]
  ): Promise<boolean> {
    let ok = true;
    const readChunk = async (chunk: string[]) => {
      const mark = timelineMark();
      patch((e) => beginTimelineFetch(e, mark));
      const details: Partial<TimelineDetails> = {};
      const readKind = async <K extends DetailKind>(kind: K) => {
        try {
          details[kind] = await read(kind, chunk);
        } catch {
          ok = false;
        }
      };
      await Promise.all(wanted.map(readKind));
      patch((e) => applyTimelineDetails(e, chunk, details, mark, wanted));
    };
    const chunks: Promise<void>[] = [];
    for (let i = 0; i < ids.length; i += DETAIL_IDS_MAX)
      chunks.push(readChunk(ids.slice(i, i + DETAIL_IDS_MAX)));
    await Promise.all(chunks);
    return ok;
  }

  /** What is still to be read, of the messages that are still there. */
  function missing(except: readonly string[] = []) {
    const entry = get();
    const skip = new Set(except);
    const live = (entry?.timeline.messages ?? [])
      .filter((m) => !m.deletedAt && !skip.has(m.id))
      .map((m) => m.id);
    return kinds
      .map((kind) => {
        const failed = new Set(entry?.missing[kind]);
        return { kind, ids: live.filter((id) => failed.has(id)) };
      })
      .filter(({ ids }) => ids.length > 0);
  }

  function again() {
    const delay = DETAIL_RETRY_DELAYS_MS[failures];
    if (!shown || timer || delay === undefined) return;
    failures += 1;
    timer = setTimeout(() => void readMissing(), delay);
  }

  async function readMissing(except?: readonly string[]) {
    clearTimeout(timer);
    timer = undefined;
    const reads = missing(except).map(({ kind, ids }) => fetch(ids, [kind]));
    if ((await Promise.all(reads)).includes(false)) again();
  }

  async function load(ids: string[]) {
    if (ids.length === 0 || (await fetch(ids, kinds))) return;
    if (!timer) failures = 0;
    again();
  }

  return {
    /** On screen, where a failure is retried, until the returned stop. */
    show() {
      shown = true;
      return () => {
        shown = false;
        clearTimeout(timer);
        timer = undefined;
      };
    },
    load,
    /** After a gap: `ids` again, and what is missing of the others. */
    async catchUp(ids: string[]) {
      failures = 0;
      await Promise.all([readMissing(ids), load(ids)]);
    },
    /** Someone asked for it. */
    retry() {
      failures = 0;
      void readMissing();
    },
  };
}
