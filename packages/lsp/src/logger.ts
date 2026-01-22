import type * as ts from 'typescript';

/**
 * Log levels for the LSP logger.
 */
export enum LogLevel {
  VERBOSE = 'VERBOSE',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

/**
 * Logger for TypeScript Language Service Plugin.
 *
 * Provides structured logging with multiple levels and performance optimizations.
 * All logging is automatically disabled when TypeScript Server logging is off.
 *
 * Compatible with VS Code, IntelliJ IDEA, WebStorm, and other TypeScript IDEs.
 * Gracefully degrades features not supported by the IDE (e.g., log groups).
 *
 * @example
 * ```ts
 * const logger = new LSPLogger(info.project?.projectService?.logger);
 *
 * logger.info('Running analysis');
 * logger.warn('Potential issue detected');
 * logger.error('Validation failed');
 *
 * // Lazy evaluation for expensive operations
 * logger.lazyVerbose(() => `Details: ${JSON.stringify(data)}`);
 *
 * // Group related logs (no-op in IDEs without group support)
 * logger.startGroup('Analysis');
 * logger.info('Step 1');
 * logger.info('Step 2');
 * logger.endGroup();
 * ```
 */
export class LSPLogger {
  private readonly hasGroupSupport: boolean;
  private readonly hasLoggingEnabledSupport: boolean;

  constructor(private readonly logger?: ts.server.Logger) {
    this.hasGroupSupport = typeof this.logger?.startGroup === 'function' &&
                           typeof this.logger?.endGroup === 'function';
    this.hasLoggingEnabledSupport = typeof this.logger?.loggingEnabled === 'function';
  }

  /**
   * Check if logging is currently enabled in TypeScript Server.
   * Falls back to checking if logger exists for IDEs without loggingEnabled support.
   */
  private shouldLog(): boolean {
    if (!this.logger) return false;

    if (this.hasLoggingEnabledSupport) {
      return this.logger.loggingEnabled();
    }

    return true;
  }

  /**
   * Internal log method with level formatting.
   */
  private log(level: LogLevel, msg: string): void {
    if (!this.shouldLog()) return;

    this.logger!.info(`[NeoSyringe ${level}] ${msg}`);
  }

  /**
   * Log verbose diagnostic information.
   * Use for detailed internal operations.
   */
  verbose(msg: string): void {
    this.log(LogLevel.VERBOSE, msg);
  }

  /**
   * Log general information.
   * Use for analysis progress and results.
   */
  info(msg: string): void {
    this.log(LogLevel.INFO, msg);
  }

  /**
   * Log warnings for non-critical issues.
   * Use for fallbacks or potential problems.
   */
  warn(msg: string): void {
    this.log(LogLevel.WARN, msg);
  }

  /**
   * Log errors for critical failures.
   * Use for exceptions and validation failures.
   */
  error(msg: string): void {
    this.log(LogLevel.ERROR, msg);
  }

  /**
   * Log with lazy message evaluation.
   * Message factory is only called if logging is enabled.
   *
   * @param msgFactory - Function that returns the log message
   *
   * @example
   * ```ts
   * // Expensive operation only runs if logging is enabled
   * logger.lazyInfo(() => `Config: ${JSON.stringify(complexObject)}`);
   * ```
   */
  lazyInfo(msgFactory: () => string): void {
    if (!this.shouldLog()) return;
    this.info(msgFactory());
  }

  /**
   * Log verbose message with lazy evaluation.
   *
   * @param msgFactory - Function that returns the log message
   */
  lazyVerbose(msgFactory: () => string): void {
    if (!this.shouldLog()) return;
    this.verbose(msgFactory());
  }

  /**
   * Start a log group for related operations.
   * Groups help organize logs for complex analyses.
   *
   * Note: Gracefully degrades to a simple log message in IDEs without group support (e.g., IntelliJ).
   *
   * @param name - Name of the group
   *
   * @example
   * ```ts
   * logger.startGroup('Container Analysis');
   * logger.info('Found 3 containers');
   * logger.info('Validating dependencies');
   * logger.endGroup();
   * ```
   */
  startGroup(name: string): void {
    if (!this.shouldLog()) return;

    if (this.hasGroupSupport) {
      this.logger!.startGroup();
    }

    this.info(`=== ${name} ===`);
  }

  /**
   * End the current log group.
   *
   * Note: No-op in IDEs without group support (e.g., IntelliJ).
   */
  endGroup(): void {
    if (!this.shouldLog()) return;

    if (this.hasGroupSupport) {
      this.logger!.endGroup();
    }
  }

  /**
   * Check if logging is currently enabled.
   * Useful for conditional expensive operations.
   *
   * @example
   * ```ts
   * if (logger.enabled) {
   *   const details = expensiveAnalysis();
   *   logger.info(`Details: ${details}`);
   * }
   * ```
   */
  get enabled(): boolean {
    return this.shouldLog();
  }
}
