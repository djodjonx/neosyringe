/**
 * Console Logger Implementation
 * Infrastructure adapter for ILogger.
 */
import type { ILogger } from '../../shared-kernel/interfaces';

export class ConsoleLogger implements ILogger {
  private formatContext(context?: Record<string, unknown>): string {
    if (!context || Object.keys(context).length === 0) return '';
    return ` ${JSON.stringify(context)}`;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    console.debug(`[DEBUG] ${message}${this.formatContext(context)}`);
  }

  info(message: string, context?: Record<string, unknown>): void {
    console.info(`[INFO] ${message}${this.formatContext(context)}`);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(`[WARN] ${message}${this.formatContext(context)}`);
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    console.error(`[ERROR] ${message}${this.formatContext(context)}`, error ?? '');
  }
}

