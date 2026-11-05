// Browser only. Draws the meeting on a canvas, mixes its audio and records
// both. The worker ticker keeps frames coming in a hidden tab.

import { createTicker } from '@/lib/meetings/effects/ticker';

import {
  FRAME_FPS,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  finishRecording,
  type LayoutBox,
  type RecorderSink,
} from './plan';

export interface SaveSink extends RecorderSink {
  write(chunk: Blob): Promise<void>;
  close(): Promise<void>;
}

interface PickerWindow {
  showSaveFilePicker?: (o: {
    suggestedName: string;
  }) => Promise<{ createWritable(): Promise<FileSystemWritableFileStream> }>;
}

function downloadSink(fileName: string, type: string): SaveSink {
  const chunks: Blob[] = [];
  return {
    fileName: null,
    abort: () => void chunks.splice(0),
    write: async (chunk) => void chunks.push(chunk),
    close: async () => {
      const url = URL.createObjectURL(new Blob(chunks, { type }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  };
}

/**
 * Null: the person cancelled the dialog. Call it inside the click.
 * Neither sink survives a crash: the picker's stream writes to a temporary
 * file the browser moves into place on `close()`, and the download sink
 * holds everything in memory until then.
 */
export async function pickSaveSink(
  fileName: string,
  type: string
): Promise<SaveSink | null> {
  const picker = (window as unknown as PickerWindow).showSaveFilePicker;
  if (!picker) return downloadSink(fileName, type);
  let stream: FileSystemWritableFileStream;
  try {
    const handle = await picker.call(window, { suggestedName: fileName });
    stream = await handle.createWritable();
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null;
    return downloadSink(fileName, type);
  }
  let queue: Promise<void> = Promise.resolve();
  return {
    fileName,
    abort: () => void stream.abort().catch(() => {}),
    write: (chunk) => (queue = queue.then(() => stream.write(chunk))),
    close: () => queue.then(() => stream.close()),
  };
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  v: HTMLVideoElement,
  b: LayoutBox<MediaStreamTrack>
) {
  const pick = b.fit === 'cover' ? Math.max : Math.min;
  const s = pick(b.w / v.videoWidth, b.h / v.videoHeight);
  const w = v.videoWidth * s;
  const h = v.videoHeight * s;
  ctx.save();
  ctx.beginPath();
  ctx.rect(b.x, b.y, b.w, b.h);
  ctx.clip();
  ctx.drawImage(v, b.x + (b.w - w) / 2, b.y + (b.h - h) / 2, w, h);
  ctx.restore();
}

function drawInitials(
  ctx: CanvasRenderingContext2D,
  b: LayoutBox<MediaStreamTrack>
) {
  const r = Math.min(b.w, b.h) / 5;
  ctx.fillStyle = '#3b5b8c';
  ctx.beginPath();
  ctx.arc(b.x + b.w / 2, b.y + b.h / 2, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${Math.round(r * 0.8)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const initials = b.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
  ctx.fillText(initials, b.x + b.w / 2, b.y + b.h / 2);
}

export interface MeetingCapture {
  setBoxes(boxes: LayoutBox<MediaStreamTrack>[]): void;
  setAudio(tracks: MediaStreamTrack[]): void;
  stop(): Promise<void>;
}

/**
 * Throws if the browser cannot record: the caller clears the flag.
 * `onInterrupted` runs when the recorder or the file fails by itself.
 */
export async function startCapture(
  sink: SaveSink,
  mimeType: string,
  onInterrupted: () => void
): Promise<MeetingCapture> {
  const canvas = document.createElement('canvas');
  canvas.width = FRAME_WIDTH;
  canvas.height = FRAME_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  const videos = new Map<string, HTMLVideoElement>();
  let boxes: LayoutBox<MediaStreamTrack>[] = [];

  const videoFor = (track: MediaStreamTrack) => {
    let v = videos.get(track.id);
    if (!v) {
      v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.srcObject = new MediaStream([track]);
      void v.play().catch(() => {});
      videos.set(track.id, v);
    }
    return v;
  };

  const draw = () => {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    for (const b of boxes) {
      const v = b.track ? videoFor(b.track) : null;
      if (v && v.videoWidth > 0) drawCover(ctx, v, b);
      else drawInitials(ctx, b);
      ctx.font = '600 18px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#fff';
      ctx.fillText(b.name, b.x + 12, b.y + b.h - 12, b.w - 24);
    }
  };

  const audio = new AudioContext();
  await audio.resume();
  const mix = audio.createMediaStreamDestination();
  const sources = new Map<string, MediaStreamAudioSourceNode>();

  draw();
  const ticker = createTicker(draw, FRAME_FPS);
  const [videoTrack] = canvas.captureStream(FRAME_FPS).getVideoTracks();
  const recorder = new MediaRecorder(
    new MediaStream([videoTrack, ...mix.stream.getAudioTracks()]),
    { mimeType, videoBitsPerSecond: 1_500_000 }
  );
  let writes: Promise<void> = Promise.resolve();
  let writeError: unknown = null;
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    writes = writes
      .then(() => (writeError ? undefined : sink.write(e.data)))
      .catch((err) => {
        writeError = err;
        onInterrupted();
      });
  };
  const ended = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  // It stops itself on an error, and nothing else would notice.
  recorder.onerror = () => onInterrupted();
  recorder.start(2000);

  return {
    setBoxes(next) {
      boxes = next;
      const live = new Set(next.map((b) => b.track?.id));
      for (const [id, v] of videos) {
        if (live.has(id)) continue;
        v.srcObject = null;
        videos.delete(id);
      }
    },
    setAudio(tracks) {
      const wanted = new Set(tracks.map((t) => t.id));
      for (const [id, node] of sources) {
        if (wanted.has(id)) continue;
        node.disconnect();
        sources.delete(id);
      }
      for (const t of tracks) {
        if (sources.has(t.id)) continue;
        const node = audio.createMediaStreamSource(new MediaStream([t]));
        node.connect(mix); // never to `destination`: that would echo
        sources.set(t.id, node);
      }
    },
    async stop() {
      ticker.stop();
      try {
        await finishRecording({
          recorder,
          ended,
          sink,
          flushed: async () => {
            await writes;
            if (writeError) throw writeError;
          },
        });
      } finally {
        videoTrack.stop();
        for (const v of videos.values()) v.srcObject = null;
        await audio.close().catch(() => {});
      }
    },
  };
}
