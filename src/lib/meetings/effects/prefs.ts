// The saved background choice. Anything that is not a whole valid effect
// reads as none: this string outlives deploys.
import { isBackdropPreset, type BackgroundEffect } from './types';

export const EFFECT_PREF_KEY = 'meetings:background';
/** Measured on the stored string: localStorage holds ~5 MB per origin. */
export const MAX_CUSTOM_IMAGE_BYTES = 300 * 1024;
const MAX_IMAGE_EDGE = 1280;
const JPEG_DATA_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

const isCustomImage = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length <= MAX_CUSTOM_IMAGE_BYTES &&
  JPEG_DATA_URL.test(v);

export function isBackgroundEffect(v: unknown): v is BackgroundEffect {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  if (e.kind === 'none') return true;
  if (e.kind === 'blur')
    return e.strength === 'light' || e.strength === 'strong';
  if (e.kind === 'color') return isBackdropPreset(e.preset);
  return e.kind === 'image' && isCustomImage(e.dataUrl);
}

export function parseEffectPref(
  raw: string | null | undefined
): BackgroundEffect {
  try {
    const v: unknown = JSON.parse(raw ?? '');
    return isBackgroundEffect(v) ? v : { kind: 'none' };
  } catch {
    return { kind: 'none' };
  }
}

/** `null` when the effect may not be stored (an image over the limit). */
export function serializeEffectPref(effect: BackgroundEffect): string | null {
  return isBackgroundEffect(effect) ? JSON.stringify(effect) : null;
}

/** Browser only. An upload as a storable JPEG, or `null` if none fits. */
export async function imageFileToDataUrl(file: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  const s = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * s);
  canvas.height = Math.round(bitmap.height * s);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.8, 0.65, 0.5, 0.35]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if (isCustomImage(url)) return url;
  }
  return null;
}
