/**
 * Runs async tasks one at a time, in the order they were queued.
 *
 * Every offer/answer exchange on the room's single RTCPeerConnection
 * goes through one of these: two overlapping exchanges would interleave
 * setLocalDescription/setRemoteDescription calls and leave the
 * connection in the wrong signalling state. A failed task rejects its
 * own promise only; the next task still runs.
 */
export interface SerialQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks queued or running. */
  readonly size: number;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let size = 0;
  const done = () => {
    size -= 1;
  };
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      size += 1;
      const result = tail.then(task);
      tail = result.then(done, done);
      return result;
    },
    get size() {
      return size;
    },
  };
}
