/**
 * Minimal logger interface used by core analyzer components.
 * Keeps the core package decoupled from any specific log sink.
 */
export interface ILogger {
  warn(message: string): void;
}

/**
 * Default logger that writes to the Node.js console.
 */
export const consoleLogger: ILogger = {
  warn: (message) => console.warn(message),
};
