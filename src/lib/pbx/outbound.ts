// ============================================================
// Calling out from the CRM (click-to-call, the keypad, the call-back
// dialler) is switched off unless NEXT_PUBLIC_PBX_OUTBOUND_CALLS is
// exactly `on`. On a Yeastar plan without the Linkus Web SDK the PBX
// rings the person's Linkus app first, which the workspace did not want,
// so the default is off. Incoming calls, the call log, recordings,
// voicemail and the controls of a call already in progress are not
// affected.
//
// It is a NEXT_PUBLIC_ variable so the browser hides the Call buttons
// and the server refuses the dial with the same answer; like every
// NEXT_PUBLIC_ value it is inlined at build time, so changing it needs a
// rebuild. The env read stays a literal `process.env.NEXT_PUBLIC_…`
// member expression, the only form Next inlines.
// ============================================================

/** Whether this build may place calls from the CRM. */
export const outboundCallsEnabled = (): boolean =>
  process.env.NEXT_PUBLIC_PBX_OUTBOUND_CALLS === 'on';
