// ============================================================
// The browser softphone seam (module 015). The call screens work in
// desk-phone mode on their own: the PBX rings the person's desk phone
// or Linkus app, and Hang up / Mute / Hold / Transfer go through
// /api/pbx/calls/{pbxCallId}/{action} on their own leg. A softphone
// (the Linkus Web SDK, implemented by the next job) registers an
// adapter with the call provider (`useCalls().registerSoftphone`);
// while `isActive()` is true, Answer, Decline, Hang up, Mute, Hold and
// the keypad use it instead.
//
// Click-to-call keeps using POST /api/pbx/calls/dial either way, so the
// server's own-extension and do-not-contact rules always apply; `call`
// is for a dial pad inside the softphone itself.
// ============================================================

/** Which call an action is for: the PBX's id, and the outside number. */
export interface SoftphoneCallRef {
  pbxCallId: string;
  remoteNumber: string | null;
}

export interface SoftphoneAdapter {
  /** Registered and handling this person's calls in this tab. */
  isActive(): boolean;
  /** Called whenever `isActive()` may have changed; returns an unsubscribe. */
  subscribe(onChange: () => void): () => void;
  answer(call: SoftphoneCallRef): Promise<void>;
  decline(call: SoftphoneCallRef): Promise<void>;
  hangup(call: SoftphoneCallRef): Promise<void>;
  mute(call: SoftphoneCallRef, muted: boolean): Promise<void>;
  hold(call: SoftphoneCallRef, held: boolean): Promise<void>;
  /** Keypad tones, one or more of 0-9 * #. */
  dtmf(call: SoftphoneCallRef, digits: string): Promise<void>;
  call(number: string): Promise<void>;
}
