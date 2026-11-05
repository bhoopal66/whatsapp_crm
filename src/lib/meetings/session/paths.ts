// Which screen the call's room lives on: the one meeting path that is
// full-bleed, and the one page that hides the float.

const ROOM_PATH = /^\/meetings\/([^/]+)\/room\/?$/;

/** The meeting whose room this path is, or null for any other path. */
export function meetingRoomIdFrom(pathname: string): string | null {
  return ROOM_PATH.exec(pathname)?.[1] ?? null;
}

export function isMeetingRoomPath(pathname: string): boolean {
  return meetingRoomIdFrom(pathname) !== null;
}
