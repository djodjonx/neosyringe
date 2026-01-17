import { describe, it, expect } from 'vitest';
import { defineBuilderConfig, useInterface } from '../src/index';

// Mocks for type checking tests
interface ILogger {
  log(msg: string): void;
}

class UserService {
  constructor(private logger: ILogger) {}
}

describe('Neo-Syringe Core API', () => {
  it('should throw at runtime when defineBuilderConfig is called without plugin', () => {
    expect(() => defineBuilderConfig({
      injections: [
        { token: UserService }
      ]
    })).toThrowError(/neo-syringe: defineBuilderConfig\(\) called at runtime/);
  });

  it('should export useInterface function', () => {
    expect(useInterface).toBeDefined();
    expect(typeof useInterface).toBe('function');
  });

  it('should throw at runtime when useInterface is called without plugin', () => {
    expect(() => useInterface<ILogger>()).toThrowError(/neo-syringe: useInterface<T>\(\) called at runtime/);
  });
});

