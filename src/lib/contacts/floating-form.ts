/**
 * Whether a FLOATING contact form (non-modal, beside a ringing call
 * card) should ignore this close. base-ui listens for Escape on the
 * whole document, and with no focus trap an Escape meant for the
 * composer, a menu or another dialog would close the form and lose what
 * was typed; only an Escape pressed inside the form closes it.
 */
export function keepFloatingFormOpen(input: {
  floating: boolean;
  reason: string;
  insideForm: boolean;
}): boolean {
  return input.floating && input.reason === 'escape-key' && !input.insideForm;
}
