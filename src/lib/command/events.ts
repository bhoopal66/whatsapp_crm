/**
 * The command bar is mounted once, in the dashboard shell. Anything else
 * (the header button, a future menu entry) opens it by this window event,
 * so no context or prop has to reach through the layout.
 */
export const OPEN_COMMAND_BAR_EVENT = 'command-bar:open';

/** Ask the mounted command bar to open. A no-op on the server. */
export function openCommandBar(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(OPEN_COMMAND_BAR_EVENT));
}
