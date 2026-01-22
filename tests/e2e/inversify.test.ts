/**
 * E2E Tests - NeoSyringe with InversifyJS Legacy Container
 *
 * Tests the integration with a real Inversify container.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { Container, injectable } from 'inversify';
import * as ts from 'typescript';
import { Analyzer } from '../../packages/core/src/analyzer/index';
import { GraphValidator } from '../../packages/core/src/generator/index';
import { Generator } from '../../packages/core/src/generator/index';

describe('E2E - NeoSyringe with InversifyJS', () => {
  let inversifyContainer: Container;

  beforeEach(() => {
    inversifyContainer = new Container();
  });

  const compileAndGenerate = (fileContent: string) => {
    const fileName = 'e2e-inversify.ts';

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

  describe('Compilation with Inversify bridge', () => {
    it('should generate valid code bridging to Inversify', () => {
      const { code } = compileAndGenerate(`

        class DatabaseConnection {
          query(sql: string) { return []; }
        }

        class CacheService {
          get(key: string) { return null; }
          set(key: string, value: any) {}
        }

        const legacy = declareContainerTokens<{
          DatabaseConnection: DatabaseConnection;
          CacheService: CacheService;
        }>(inversifyContainer);

        class ReportService {
          constructor(
            private db: DatabaseConnection,
            private cache: CacheService
          ) {}
        }

        export const container = defineBuilderConfig({
          name: 'ReportingApp',
          useContainer: legacy,
          injections: [
            { token: ReportService }
          ]
        });
      `);

      expect(code).toContain('class NeoContainer');
      expect(code).toContain('[legacy]');
      expect(code).toContain("'ReportingApp'");
    });
  });

  describe('Runtime execution with Inversify', () => {
    it('should resolve services from Inversify at runtime', () => {
      // 1. Define and register in Inversify
      @injectable()
      class InversifyDatabase {
        private data = new Map<string, any>();

        save(id: string, entity: any) {
          this.data.set(id, entity);
        }

        find(id: string) {
          return this.data.get(id);
        }
      }

      inversifyContainer.bind(InversifyDatabase).toSelf().inSingletonScope();

      // 2. Wrapper to make Inversify compatible with our resolve() interface
      const inversifyWrapper = {
        resolve: <T>(token: any): T => {
          return inversifyContainer.get<T>(token);
        }
      };

      // 3. Create NeoContainer with Inversify as legacy
      class NeoContainer {
        private instances = new Map<any, any>();

        constructor(
          private parent?: any,
          private legacy?: any[],
          private name: string = 'TestContainer'
        ) {}

        resolve<T>(token: any): T {
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

      const container = new NeoContainer(undefined, [inversifyWrapper], 'InversifyApp');

      // 4. Test
      const db = container.resolve<InversifyDatabase>(InversifyDatabase);
      db.save('user-1', { name: 'Alice' });

      expect(db.find('user-1')).toEqual({ name: 'Alice' });
    });

    it('should resolve mixed Inversify + NeoSyringe services', () => {
      // Inversify service
      @injectable()
      class InversifyLogger {
        private logs: string[] = [];

        log(msg: string) {
          this.logs.push(msg);
        }

        getLogs() {
          return this.logs;
        }
      }

      inversifyContainer.bind(InversifyLogger).toSelf().inSingletonScope();

      // NeoSyringe service
      class OrderService {
        constructor(private logger: InversifyLogger) {}

        createOrder(productId: string, quantity: number) {
          this.logger.log(`Order created: ${productId} x ${quantity}`);
          return { id: 'order-1', productId, quantity };
        }
      }

      // Wrapper
      const inversifyWrapper = {
        resolve: <T>(token: any): T => inversifyContainer.get<T>(token)
      };

      // Container
      class NeoContainer {
        private instances = new Map<any, any>();

        constructor(private legacy: any[]) {}

        resolve<T>(token: any): T {
          // Local
          if (token === OrderService) {
            if (!this.instances.has(OrderService)) {
              const logger = this.resolve<InversifyLogger>(InversifyLogger);
              this.instances.set(OrderService, new OrderService(logger));
            }
            return this.instances.get(OrderService);
          }

          // Legacy
          for (const container of this.legacy) {
            try { return container.resolve(token); } catch {}
          }

          throw new Error('Not found');
        }
      }

      const container = new NeoContainer([inversifyWrapper]);

      // Test
      const orderService = container.resolve<OrderService>(OrderService);
      const order = orderService.createOrder('product-123', 2);

      expect(order).toEqual({ id: 'order-1', productId: 'product-123', quantity: 2 });

      const logger = container.resolve<InversifyLogger>(InversifyLogger);
      expect(logger.getLogs()).toContain('Order created: product-123 x 2');
    });

    it('should handle Inversify scopes correctly', () => {
      @injectable()
      class TransientCounter {
        private static instanceCount = 0;
        public readonly instanceId: number;

        constructor() {
          this.instanceId = ++TransientCounter.instanceCount;
        }
      }

      // Bind as transient (new instance each time)
      inversifyContainer.bind(TransientCounter).toSelf().inTransientScope();

      const inversifyWrapper = {
        resolve: <T>(token: any): T => inversifyContainer.get<T>(token)
      };

      class NeoContainer {
        constructor(private legacy: any[]) {}
        resolve<T>(token: any): T {
          for (const container of this.legacy) {
            try { return container.resolve(token); } catch {}
          }
          throw new Error('Not found');
        }
      }

      const container = new NeoContainer([inversifyWrapper]);

      const counter1 = container.resolve<TransientCounter>(TransientCounter);
      const counter2 = container.resolve<TransientCounter>(TransientCounter);

      // Should be different instances (transient scope)
      expect(counter1.instanceId).not.toBe(counter2.instanceId);
    });
  });
});

