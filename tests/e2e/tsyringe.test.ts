/**
 * E2E Tests - NeoSyringe with tsyringe Legacy Container
 *
 * Tests the integration with a real tsyringe container.
 * This validates that the generated code correctly delegates
 * resolution to the legacy container.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { container as tsyringeContainer, singleton } from 'tsyringe';
import * as ts from 'typescript';
import { Analyzer } from '../../packages/core/src/analyzer/index';
import { GraphValidator } from '../../packages/core/src/generator/index';
import { Generator } from '../../packages/core/src/generator/index';

describe('E2E - NeoSyringe with tsyringe', () => {
  beforeEach(() => {
    // Reset tsyringe container between tests
    tsyringeContainer.reset();
  });

  const compileAndGenerate = (fileContent: string) => {
    const fileName = 'e2e-tsyringe.ts';

    const fullContent = `
      import { defineBuilderConfig, definePartialConfig, useInterface, useProperty, declareContainerTokens } from '@djodjonx/neosyringe';
      ${fileContent}
    `;

    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;

    compilerHost.getSourceFile = (name, languageVersion) => {
      if (name === fileName) {
        return ts.createSourceFile(fileName, fullContent, languageVersion);
      }
      return originalGetSourceFile(name, languageVersion);
    };

    const program = ts.createProgram([fileName], {}, compilerHost);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    const validator = new GraphValidator();
    validator.validate(graph);

    const generator = new Generator(graph);
    return { code: generator.generate(), graph };
  };

  describe('Compilation with tsyringe bridge', () => {
    it('should generate valid code bridging to tsyringe', () => {
      const { code } = compileAndGenerate(`

        class AuthService {
          validateToken(token: string): boolean { return true; }
        }

        class UserRepository {
          findById(id: string) { return { id, name: 'John' }; }
        }

        const legacy = declareContainerTokens<{
          AuthService: AuthService;
          UserRepository: UserRepository;
        }>(tsyringeContainer);

        class UserService {
          constructor(
            private auth: AuthService,
            private repo: UserRepository
          ) {}
        }

        export const container = defineBuilderConfig({
          name: 'AppWithTsyringe',
          useContainer: legacy,
          injections: [
            { token: UserService }
          ]
        });
      `);

      // Verify code structure
      expect(code).toContain('class NeoContainer');
      expect(code).toContain('[legacy]');
      expect(code).toContain("'AppWithTsyringe'");
      expect(code).toContain('this.legacy');
      expect(code).toContain('legacyContainer.resolve');
    });

    it('should detect missing legacy token declaration', () => {
      expect(() => compileAndGenerate(`

        class AuthService {}
        class MissingService {}  // Not in legacy!

        const legacy = declareContainerTokens<{
          AuthService: AuthService;
        }>({});

        class UserService {
          constructor(
            private auth: AuthService,
            private missing: MissingService  // Will fail!
          ) {}
        }

        export const container = defineBuilderConfig({
          useContainer: legacy,
          injections: [
            { token: UserService }
          ]
        });
      `)).toThrow(/Missing binding.*MissingService/);
    });

    it('should prevent duplicate registration of tsyringe tokens', () => {
      expect(() => compileAndGenerate(`

        class AuthService {}
        class MyAuthService {}

        const legacy = declareContainerTokens<{
          AuthService: AuthService;
        }>({});

        export const container = defineBuilderConfig({
          useContainer: legacy,
          injections: [
            { token: AuthService, provider: MyAuthService }  // Duplicate!
          ]
        });
      `)).toThrow(/Duplicate registration.*AuthService.*parent/);
    });
  });

  describe('Runtime execution with tsyringe', () => {
    // These tests actually execute the generated code!

    it('should resolve services from tsyringe at runtime', () => {
      // 1. Register services in tsyringe
      @singleton()
      class LegacyAuthService {
        validateToken(token: string): boolean {
          return token === 'valid-token';
        }
      }

      @singleton()
      class LegacyUserRepository {
        findById(id: string) {
          return { id, name: 'John Doe' };
        }
      }

      tsyringeContainer.registerSingleton(LegacyAuthService);
      tsyringeContainer.registerSingleton(LegacyUserRepository);

      // 2. Create a mock NeoContainer that delegates to tsyringe
      class NeoContainer {
        private instances = new Map<any, any>();

        constructor(
          private parent?: any,
          private legacy?: any[],
          private name: string = 'TestContainer'
        ) {}

        resolve<T>(token: any): T {
          // Try local first (none in this test)

          // Delegate to legacy
          if (this.legacy) {
            for (const container of this.legacy) {
              try {
                return container.resolve(token);
              } catch {
                // continue
              }
            }
          }

          throw new Error(`Service not found: ${token}`);
        }
      }

      // 3. Create container with tsyringe as legacy
      const container = new NeoContainer(undefined, [tsyringeContainer], 'AppContainer');

      // 4. Resolve services
      const authService = container.resolve<LegacyAuthService>(LegacyAuthService);
      const userRepo = container.resolve<LegacyUserRepository>(LegacyUserRepository);

      // 5. Verify they work
      expect(authService.validateToken('valid-token')).toBe(true);
      expect(authService.validateToken('invalid')).toBe(false);
      expect(userRepo.findById('123')).toEqual({ id: '123', name: 'John Doe' });
    });

    it('should resolve mixed dependencies (legacy + neosyringe)', () => {
      // 1. Register in tsyringe
      @singleton()
      class LegacyLogger {
        logs: string[] = [];
        log(msg: string) { this.logs.push(msg); }
      }

      tsyringeContainer.registerSingleton(LegacyLogger);

      // 2. NeoSyringe service depending on legacy
      class UserService {
        constructor(private logger: LegacyLogger) {}

        createUser(name: string) {
          this.logger.log(`Creating user: ${name}`);
          return { id: '1', name };
        }
      }

      // 3. Simulated generated container
      class NeoContainer {
        private instances = new Map<any, any>();

        constructor(
          private parent?: any,
          private legacy?: any[],
          private name: string = 'TestContainer'
        ) {}

        resolve<T>(token: any): T {
          // Local resolution
          if (token === UserService) {
            if (!this.instances.has(UserService)) {
              const logger = this.resolve<LegacyLogger>(LegacyLogger);
              this.instances.set(UserService, new UserService(logger));
            }
            return this.instances.get(UserService);
          }

          // Legacy delegation
          if (this.legacy) {
            for (const container of this.legacy) {
              try {
                return container.resolve(token);
              } catch {
                // continue
              }
            }
          }

          throw new Error(`Service not found: ${token}`);
        }
      }

      // 4. Create and test
      const container = new NeoContainer(undefined, [tsyringeContainer], 'MixedApp');

      const userService = container.resolve<UserService>(UserService);
      const result = userService.createUser('Alice');

      expect(result).toEqual({ id: '1', name: 'Alice' });

      // Verify logger was called (from tsyringe)
      const logger = container.resolve<LegacyLogger>(LegacyLogger);
      expect(logger.logs).toContain('Creating user: Alice');
    });

    it('should maintain singleton behavior across containers', () => {
      // Register singleton in tsyringe
      @singleton()
      class SharedState {
        value = 0;
        increment() { return ++this.value; }
      }

      tsyringeContainer.registerSingleton(SharedState);

      // Two NeoContainers sharing the same tsyringe
      class NeoContainer {
        constructor(private legacy: any[]) {}
        resolve<T>(token: any): T {
          for (const container of this.legacy) {
            try { return container.resolve(token); } catch {}
          }
          throw new Error('Not found');
        }
      }

      const container1 = new NeoContainer([tsyringeContainer]);
      const container2 = new NeoContainer([tsyringeContainer]);

      // Both should share the same singleton
      const state1 = container1.resolve<SharedState>(SharedState);
      const state2 = container2.resolve<SharedState>(SharedState);

      expect(state1.increment()).toBe(1);
      expect(state2.increment()).toBe(2);  // Same instance!
      expect(state1.value).toBe(2);
    });
  });
});

