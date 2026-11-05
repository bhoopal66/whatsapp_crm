// Browser only. Raw camera in, processed track out: hidden <video> ->
// 256-wide copy -> segmenter -> mask -> composite canvas -> captureStream.
// The segmenter gets the small copy because it resizes its mask to its
// input: 720p would mean a 921,600-float readback per frame for a model
// that looks at 256x256. Upscaling the small mask also softens the edge.
import type { ImageSegmenter } from '@mediapipe/tasks-vision';
import { blockMediaPipeLogging } from './block-logging';
import { initialBudget, stepBudget } from './frame-budget';
import { writeMaskAlpha } from './mask';
import { createTicker, type Ticker } from './ticker';
import {
  BACKDROP_PRESETS,
  EffectsError,
  type BackdropPreset,
  type BackgroundEffect,
} from './types';

const ASSETS = '/meeting-effects';
const SEG_W = 256;
const VIDEO_TIMEOUT_MS = 8000;
/** In pixels of the 256-wide copy, so ~5x that on a 720p output. */
const BLUR_PX = { light: 2, strong: 5 } as const;
/** Width to shrink to where ctx.filter is missing (Safari). */
const SHRINK_W = { light: 96, strong: 40 } as const;

export interface VideoEffectProcessor {
  /** Starts on `input`; resolves with the track to publish. */
  start(
    input: MediaStreamTrack,
    effect: BackgroundEffect
  ): Promise<MediaStreamTrack>;
  setEffect(effect: BackgroundEffect): void; // no new output track
  /** New raw camera (device switch); the output track stays the same. */
  setInput(input: MediaStreamTrack): Promise<void>;
  stop(): void; // releases GPU/wasm, stops the output, never stops `input`
  /** After it fires, frames pass through unblurred until the caller acts. */
  onGiveUp(fn: () => void): void;
  stats(): { fps: number; frameMs: number | null; delegate: string | null };
}

let supported: boolean | null = null;

/** Cached: each check would cost a WebGL context, and pages hold few. */
export function effectsSupported(): boolean {
  if (typeof document === 'undefined' || typeof WebAssembly === 'undefined')
    return false;
  if (supported !== null) return supported;
  const c = document.createElement('canvas');
  // The runtime uploads frames through WebGL2 even on its CPU delegate.
  supported = typeof c.captureStream === 'function' && !!c.getContext('webgl2');
  return supported;
}

const ctx2d = (c: HTMLCanvasElement) =>
  c.getContext('2d') as CanvasRenderingContext2D;

function paintPreset(c: HTMLCanvasElement, preset: BackdropPreset) {
  const ctx = ctx2d(c);
  const { stops } =
    BACKDROP_PRESETS.find((p) => p.id === preset) ?? BACKDROP_PRESETS[0];
  const g = ctx.createLinearGradient(0, 0, c.width, c.height);
  stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
}

/** A GL that runs on the CPU: 175 ms a frame here, against ~60 for the CPU delegate. */
export const isSoftwareRenderer = (name: string) =>
  /swiftshader|llvmpipe|software/i.test(name);

function glRenderer(): string {
  const gl = document.createElement('canvas').getContext('webgl2');
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  const name = info
    ? String(gl?.getParameter(info.UNMASKED_RENDERER_WEBGL))
    : '';
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return name;
}

async function openSegmenter(probe: HTMLCanvasElement) {
  // Before the library exists: it reports usage to Google otherwise.
  blockMediaPipeLogging();
  const { FilesetResolver, ImageSegmenter } =
    await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(`${ASSETS}/wasm`);
  let failure: unknown;
  const delegates = isSoftwareRenderer(glRenderer())
    ? (['CPU'] as const)
    : (['GPU', 'CPU'] as const);
  for (const delegate of delegates) {
    let made: ImageSegmenter | undefined;
    try {
      made = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: `${ASSETS}/selfie_segmenter.tflite`,
          delegate,
        },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      // A GPU delegate can be created and then fail on its first frame.
      made.segmentForVideo(probe, 1).close();
      return { segmenter: made, delegate };
    } catch (err) {
      failure = err;
      made?.close();
    }
  }
  throw failure;
}

export function createVideoEffectProcessor(): VideoEffectProcessor {
  let run = 0; // bumped by stop(): an in-flight load sees it and bows out
  let video: HTMLVideoElement | null = null;
  let output: MediaStreamTrack | null = null;
  let ticker: Ticker | null = null;
  let segmenter: ImageSegmenter | null = null;
  let delegate: string | null = null;
  let loading: Promise<void> | null = null;
  let effect: BackgroundEffect = { kind: 'none' };
  let gaveUp = false;
  let budget = initialBudget();
  let clock = 1;
  const listeners: (() => void)[] = [];

  const [out, seg, maskCanvas, shrink, backdrop] = Array.from(
    { length: 5 },
    () => document.createElement('canvas')
  );
  let maskImage: ImageData | null = null;
  let smoothed = new Float32Array(0);

  const giveUp = () => {
    gaveUp = true;
    listeners.forEach((fn) => fn());
  };

  function paintStatic() {
    if (effect.kind === 'color') paintPreset(backdrop, effect.preset);
    if (effect.kind !== 'image') return;
    // Navy until it decodes, or if it never does: never the real room.
    paintPreset(backdrop, 'navy');
    const wanted = effect;
    const img = new Image();
    img.onload = () => {
      if (effect !== wanted) return;
      const s = Math.max(
        backdrop.width / img.naturalWidth,
        backdrop.height / img.naturalHeight
      );
      const [w, h] = [img.naturalWidth * s, img.naturalHeight * s];
      ctx2d(backdrop).drawImage(
        img,
        (backdrop.width - w) / 2,
        (backdrop.height - h) / 2,
        w,
        h
      );
    };
    img.src = effect.dataUrl;
  }

  function fit(v: HTMLVideoElement) {
    const s = Math.min(1, 1280 / v.videoWidth, 720 / v.videoHeight);
    const w = Math.round(v.videoWidth * s);
    const h = Math.round(v.videoHeight * s);
    if (out.width === w && out.height === h) return;
    out.width = backdrop.width = w;
    out.height = backdrop.height = h;
    seg.width = SEG_W;
    seg.height = Math.round((SEG_W * h) / w);
    paintStatic();
  }

  function readMask(s: ImageSegmenter) {
    clock = Math.max(clock + 1, performance.now());
    s.segmentForVideo(seg, clock, (result) => {
      const masks = result.confidenceMasks;
      const mask = masks?.[masks.length - 1]; // the person is the last class
      if (mask) {
        const fresh =
          maskImage?.width !== mask.width || maskImage.height !== mask.height;
        if (fresh || !maskImage) {
          maskCanvas.width = mask.width;
          maskCanvas.height = mask.height;
          maskImage = new ImageData(mask.width, mask.height);
          smoothed = new Float32Array(mask.width * mask.height);
        }
        const conf = mask.getAsFloat32Array();
        writeMaskAlpha(conf, smoothed, maskImage.data, fresh);
        ctx2d(maskCanvas).putImageData(maskImage, 0, 0);
      }
      result.close();
    });
  }

  function paintBlur(strength: 'light' | 'strong') {
    const bg = ctx2d(backdrop);
    if ('filter' in bg) {
      shrink.width = seg.width;
      shrink.height = seg.height;
      const c = ctx2d(shrink);
      c.filter = `blur(${BLUR_PX[strength]}px)`;
      c.drawImage(seg, 0, 0);
    } else {
      shrink.width = SHRINK_W[strength];
      shrink.height = Math.round((shrink.width * seg.height) / seg.width);
      ctx2d(shrink).drawImage(seg, 0, 0, shrink.width, shrink.height);
    }
    bg.imageSmoothingQuality = 'high';
    bg.drawImage(shrink, 0, 0, backdrop.width, backdrop.height);
  }

  function draw(v: HTMLVideoElement) {
    const { width: w, height: h } = out;
    const ctx = ctx2d(out);
    ctx.globalCompositeOperation = 'copy';
    if (effect.kind === 'none' || gaveUp || !segmenter) {
      ctx.drawImage(v, 0, 0, w, h);
      return;
    }
    ctx2d(seg).drawImage(v, 0, 0, seg.width, seg.height);
    readMask(segmenter);
    if (effect.kind === 'blur') paintBlur(effect.strength);
    ctx.drawImage(maskCanvas, 0, 0, w, h);
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(v, 0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-over';
    ctx.drawImage(backdrop, 0, 0);
  }

  function tick() {
    // Mid device switch: hold the last frame rather than flash black.
    if (!video || video.readyState < 2 || !video.videoWidth) return;
    const t0 = performance.now();
    try {
      fit(video);
      draw(video);
    } catch {
      if (!gaveUp) giveUp();
      return;
    }
    if (effect.kind === 'none' || gaveUp) return;
    const now = performance.now();
    const step = stepBudget(budget, now - t0, now);
    if (step.fps !== budget.fps) ticker?.setFps(step.fps);
    budget = step.state;
    if (step.giveUp) giveUp();
  }

  async function playInput(v: HTMLVideoElement, input: MediaStreamTrack) {
    v.srcObject = new MediaStream([input]);
    const deadline = performance.now() + VIDEO_TIMEOUT_MS;
    void v.play().catch(() => undefined); // the loop below is the verdict
    while (v.readyState < 2 || !v.videoWidth) {
      if (performance.now() > deadline)
        throw new EffectsError('no_video', 'The camera sent no frames');
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  function load(): Promise<void> {
    loading ??= openSegmenter(seg)
      .then((opened) => {
        // `video`, not the caller's run: a restart during the load shares
        // this promise, and closing here would leave it sending raw video.
        if (!video) return opened.segmenter.close();
        segmenter = opened.segmenter;
        delegate = opened.delegate;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  function stop() {
    run++;
    ticker?.stop();
    ticker = null;
    output?.stop();
    output = null;
    segmenter?.close();
    segmenter = null;
    delegate = null;
    if (video) {
      video.pause();
      video.srcObject = null;
      video.remove();
      video = null;
    }
    maskImage = null;
    for (const c of [out, seg, maskCanvas, shrink, backdrop])
      c.width = c.height = 1;
  }

  return {
    async start(input, first) {
      stop();
      const mine = run;
      effect = first;
      gaveUp = false;
      budget = initialBudget();
      try {
        if (!effectsSupported())
          throw new EffectsError('unsupported', 'No WebGL2 or captureStream');
        const v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        // In the document and painted: Safari stops decoding otherwise.
        v.style.cssText =
          'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
        document.body.append(v);
        video = v;
        await playInput(v, input);
        fit(v);
        if (first.kind !== 'none') {
          await load().catch((err) => {
            throw new EffectsError('load_failed', String(err));
          });
        }
        if (mine !== run) throw new EffectsError('stopped', 'Stopped early');
        // First frame before the track exists, so nobody sees raw video,
        // and the runtime's slow first run stays out of the budget.
        draw(v);
        output = out.captureStream().getVideoTracks()[0];
        ticker = createTicker(tick, budget.fps);
        return output;
      } catch (err) {
        if (mine === run) stop();
        throw err;
      }
    },
    setEffect(next) {
      effect = next;
      gaveUp = false;
      budget = initialBudget();
      ticker?.setFps(budget.fps);
      paintStatic();
      if (next.kind !== 'none' && !segmenter && output) load().catch(giveUp);
    },
    async setInput(input) {
      if (video) await playInput(video, input);
    },
    stop,
    onGiveUp(fn) {
      listeners.push(fn);
    },
    stats: () => ({ fps: budget.fps, frameMs: budget.avgMs, delegate }),
  };
}
