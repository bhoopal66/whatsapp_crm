// Short tones for the room: the speaker test and the optional join/leave
// sound. Browser-only; every failure is swallowed (a missing sound must
// never break the call).

type SinkAudio = HTMLAudioElement & {
  setSinkId?: (id: string) => Promise<void>;
};

function audioContextClass(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ??
    null
  );
}

export function canPlayTones(): boolean {
  return audioContextClass() !== null;
}

/**
 * Plays `notes` (Hz, each `noteMs` long) on the chosen output: an
 * oscillator into a MediaStreamDestination played by an <audio> element,
 * because only a media element can be routed with setSinkId. Without
 * setSinkId (or a sink) it plays on the default output. Resolves when
 * done; false when nothing could be played.
 */
export async function playTones(
  notes: readonly number[],
  { noteMs = 140, gain = 0.08, sinkId = null as string | null } = {}
): Promise<boolean> {
  const Ctx = audioContextClass();
  if (!Ctx || !notes.length) return false;
  let ctx: AudioContext | null = null;
  let el: SinkAudio | null = null;
  try {
    ctx = new Ctx();
    const dest = ctx.createMediaStreamDestination();
    el = new Audio() as SinkAudio;
    el.srcObject = dest.stream;
    if (sinkId && typeof el.setSinkId === 'function')
      await el.setSinkId(sinkId).catch(() => {});
    await el.play();
    const amp = ctx.createGain();
    amp.connect(dest);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.connect(amp);
    const t0 = ctx.currentTime + 0.02;
    const step = noteMs / 1000;
    notes.forEach((hz, i) => {
      const at = t0 + i * step;
      osc.frequency.setValueAtTime(hz, at);
      amp.gain.setValueAtTime(0.0001, at);
      amp.gain.exponentialRampToValueAtTime(gain, at + 0.02);
      amp.gain.exponentialRampToValueAtTime(0.0001, at + step - 0.01);
    });
    const end = t0 + notes.length * step;
    osc.start(t0);
    osc.stop(end);
    await new Promise<void>((resolve) => {
      osc.onended = () => resolve();
    });
    return true;
  } catch {
    return false;
  } finally {
    if (el) {
      el.pause();
      el.srcObject = null;
    }
    void ctx?.close().catch(() => {});
  }
}

export const JOIN_TONE = [660, 880] as const;
export const LEAVE_TONE = [880, 660] as const;
export const TEST_TONE = [523.25, 659.25, 783.99, 1046.5] as const;
