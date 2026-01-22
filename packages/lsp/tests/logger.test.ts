import { describe, it, expect, vi } from 'vitest';
import { LSPLogger, LogLevel } from '../src/logger';

describe('LSPLogger', () => {
  describe('when logger is undefined', () => {
    it('should not throw on any log method', () => {
      const logger = new LSPLogger(undefined);

      expect(() => {
        logger.verbose('test');
        logger.info('test');
        logger.warn('test');
        logger.error('test');
        logger.startGroup('test');
        logger.endGroup();
        logger.lazyInfo(() => 'test');
      }).not.toThrow();
    });

    it('should report enabled as false', () => {
      const logger = new LSPLogger(undefined);
      expect(logger.enabled).toBe(false);
    });
  });

  describe('when loggingEnabled is false', () => {
    it('should not call logger.info', () => {
      const mockLogger = {
        loggingEnabled: vi.fn(() => false),
        info: vi.fn(),
        startGroup: vi.fn(),
        endGroup: vi.fn(),
      };

      const logger = new LSPLogger(mockLogger as any);
      logger.info('test message');

      expect(mockLogger.loggingEnabled).toHaveBeenCalled();
      expect(mockLogger.info).not.toHaveBeenCalled();
    });

    it('should not evaluate lazy functions', () => {
      const mockLogger = {
        loggingEnabled: () => false,
        info: vi.fn(),
      };

      const logger = new LSPLogger(mockLogger as any);
      const expensiveFunction = vi.fn(() => 'expensive result');

      logger.lazyInfo(expensiveFunction);
      logger.lazyVerbose(expensiveFunction);

      expect(expensiveFunction).not.toHaveBeenCalled();
    });

    it('should not call startGroup or endGroup', () => {
      const mockLogger = {
        loggingEnabled: () => false,
        info: vi.fn(),
        startGroup: vi.fn(),
        endGroup: vi.fn(),
      };

      const logger = new LSPLogger(mockLogger as any);

      logger.startGroup('Test Group');
      logger.endGroup();

      expect(mockLogger.startGroup).not.toHaveBeenCalled();
      expect(mockLogger.endGroup).not.toHaveBeenCalled();
    });
  });

  describe('when loggingEnabled is true', () => {
    it('should format log messages with correct level', () => {
      const mockLogger = {
        loggingEnabled: () => true,
        info: vi.fn(),
        startGroup: vi.fn(),
        endGroup: vi.fn(),
      };

      const logger = new LSPLogger(mockLogger as any);

      logger.verbose('verbose msg');
      logger.info('info msg');
      logger.warn('warn msg');
      logger.error('error msg');

      expect(mockLogger.info).toHaveBeenCalledWith('[NeoSyringe VERBOSE] verbose msg');
      expect(mockLogger.info).toHaveBeenCalledWith('[NeoSyringe INFO] info msg');
      expect(mockLogger.info).toHaveBeenCalledWith('[NeoSyringe WARN] warn msg');
      expect(mockLogger.info).toHaveBeenCalledWith('[NeoSyringe ERROR] error msg');
      expect(mockLogger.info).toHaveBeenCalledTimes(4);
    });

    it('should evaluate lazy functions and log result', () => {
      const mockLogger = {
        loggingEnabled: () => true,
        info: vi.fn(),
      };

      const logger = new LSPLogger(mockLogger as any);
      const expensiveFunction = vi.fn(() => 'expensive result');

      logger.lazyInfo(expensiveFunction);

      expect(expensiveFunction).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith('[NeoSyringe INFO] expensive result');
    });

    it('should handle groups correctly', () => {
      const mockLogger = {
        loggingEnabled: () => true,
        info: vi.fn(),
        startGroup: vi.fn(),
        endGroup: vi.fn(),
      };

      const logger = new LSPLogger(mockLogger as any);

      logger.startGroup('Test Group');
      logger.info('inside group');
      logger.endGroup();

      expect(mockLogger.startGroup).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith('[NeoSyringe INFO] === Test Group ===');
      expect(mockLogger.info).toHaveBeenCalledWith('[NeoSyringe INFO] inside group');
      expect(mockLogger.endGroup).toHaveBeenCalledTimes(1);
    });

    it('should report enabled as true', () => {
      const mockLogger = {
        loggingEnabled: () => true,
        info: vi.fn(),
      };

      const logger = new LSPLogger(mockLogger as any);
      expect(logger.enabled).toBe(true);
    });
  });

  describe('lazy evaluation performance', () => {
    it('should not construct strings when logging is disabled', () => {
      const mockLogger = {
        loggingEnabled: () => false,
        info: vi.fn(),
      };

      const logger = new LSPLogger(mockLogger as any);
      const expensiveOp = vi.fn(() => {
        return JSON.stringify({ large: 'object' });
      });

      logger.lazyVerbose(expensiveOp);

      expect(expensiveOp).not.toHaveBeenCalled();
    });

    it('should only construct strings once when logging is enabled', () => {
      const mockLogger = {
        loggingEnabled: () => true,
        info: vi.fn(),
      };

      const logger = new LSPLogger(mockLogger as any);
      const expensiveOp = vi.fn(() => 'result');

      logger.lazyInfo(expensiveOp);
      logger.lazyVerbose(expensiveOp);

      expect(expensiveOp).toHaveBeenCalledTimes(2);
    });
  });

  describe('LogLevel enum', () => {
    it('should export correct log level values', () => {
      expect(LogLevel.VERBOSE).toBe('VERBOSE');
      expect(LogLevel.INFO).toBe('INFO');
      expect(LogLevel.WARN).toBe('WARN');
      expect(LogLevel.ERROR).toBe('ERROR');
    });
  });

  describe('real-world scenarios', () => {
    it('should handle nested groups', () => {
      const mockLogger = {
        loggingEnabled: () => true,
        info: vi.fn(),
        startGroup: vi.fn(),
        endGroup: vi.fn(),
      };

      const logger = new LSPLogger(mockLogger as any);

      logger.startGroup('Outer');
      logger.info('outer message');
      logger.startGroup('Inner');
      logger.info('inner message');
      logger.endGroup();
      logger.endGroup();

      expect(mockLogger.startGroup).toHaveBeenCalledTimes(2);
      expect(mockLogger.endGroup).toHaveBeenCalledTimes(2);
    });

    it('should handle mixed log levels in sequence', () => {
      const mockLogger = {
        loggingEnabled: () => true,
        info: vi.fn(),
      };

      const logger = new LSPLogger(mockLogger as any);

      logger.info('Starting analysis');
      logger.verbose('Found 3 files');
      logger.warn('Skipping invalid file');
      logger.error('Analysis failed');

      expect(mockLogger.info).toHaveBeenCalledTimes(4);
      expect(mockLogger.info.mock.calls[0][0]).toContain('INFO');
      expect(mockLogger.info.mock.calls[1][0]).toContain('VERBOSE');
      expect(mockLogger.info.mock.calls[2][0]).toContain('WARN');
      expect(mockLogger.info.mock.calls[3][0]).toContain('ERROR');
    });
  });
});
