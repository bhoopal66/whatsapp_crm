/** Where the edge guards report a degraded store or a dropped event. */
export interface EdgeLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export const consoleLogger: EdgeLogger = {
  warn: (msg, meta) => console.warn(`[edge] ${msg}`, meta ?? {}),
};
