// Hold Space to talk: the press and the release. keys.ts decides which
// key events count; this keeps the release from ever leaving someone
// unmuted.

export interface TalkPort {
  /** The engine's live answer, not a rendered copy that may lag it. */
  micOn: () => boolean;
  toggleMic: () => Promise<void>;
}

export interface HoldToTalk {
  held: () => boolean;
  press: () => void;
  release: () => Promise<void>;
}

export function createHoldToTalk(port: TalkPort): HoldToTalk {
  let held = false;
  let opening: Promise<void> = Promise.resolve();
  return {
    held: () => held,
    press() {
      held = true;
      opening = port.toggleMic();
    },
    async release() {
      held = false;
      // With no audio track the press is still opening the microphone,
      // and a toggle now would be ignored and leave it live once it opens.
      await opening.catch(() => {});
      // Pressed again meanwhile: that hold's own release mutes.
      if (held) return;
      // Muted some other way (M, a moderator, a failed open): a toggle
      // here would unmute.
      if (port.micOn()) await port.toggleMic();
    },
  };
}
