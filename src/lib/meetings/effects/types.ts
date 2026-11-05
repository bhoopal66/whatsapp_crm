// Background effects for staff video meetings. Pure: no DOM.

export const BACKDROP_PRESETS = [
  { id: 'navy', stops: ['#0f1f3d', '#1c3560', '#2a4a7a'] },
  { id: 'slate', stops: ['#2b323c', '#46505e', '#657180'] },
  { id: 'sand', stops: ['#cbb89d', '#ddcfb9', '#efe6d8'] },
  { id: 'mist', stops: ['#b6c4cf', '#d0dae1', '#e9eef2'] },
] as const;

export type BackdropPreset = (typeof BACKDROP_PRESETS)[number]['id'];

export type BackgroundEffect =
  | { kind: 'none' }
  | { kind: 'blur'; strength: 'light' | 'strong' }
  | { kind: 'color'; preset: BackdropPreset }
  | { kind: 'image'; dataUrl: string };

export const isBackdropPreset = (v: unknown): v is BackdropPreset =>
  BACKDROP_PRESETS.some((p) => p.id === v);

export type EffectsErrorCode =
  'unsupported' | 'no_video' | 'load_failed' | 'stopped';

/** Why `start` refused. The caller keeps sending the raw camera. */
export class EffectsError extends Error {
  constructor(
    readonly code: EffectsErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'EffectsError';
  }
}
