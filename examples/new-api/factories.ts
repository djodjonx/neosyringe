// #region imports
import { defineBuilderConfig, useInterface, useProperty } from '@djodjonx/neosyringe';
import type { Factory, FactoryContext } from '@djodjonx/neosyringe';
// #endregion imports

// The guides include the regions below one by one. The types they use are declared here.
interface ILogger {
  readonly kind: string;
}

class ConsoleLogger implements ILogger {
  readonly kind = 'console';
}

interface IConfig {
  apiUrl: string;
  timeout: number;
}

interface IHttpClient {
  describe(): string;
}

class HttpClient implements IHttpClient {
  constructor(
    readonly logger: ILogger,
    readonly baseUrl: string,
  ) {}

  describe(): string {
    return `client for ${this.baseUrl} via ${this.logger.kind}`;
  }
}

interface IDbConfig {
  connectionString: string;
}

interface IDatabase {
  status(): string;
}

class DatabaseConnection implements IDatabase {
  constructor(readonly url: string) {}

  status(): string {
    return `connected to ${this.url}`;
  }
}

interface IRequest {
  id: string;
}

interface ILoggedConfig {
  apiUrl: string;
  logger: ILogger;
}

interface IMiddleware {
  name: string;
}

class Pipeline {
  constructor(readonly middleware: IMiddleware[]) {}

  names(): string[] {
    return this.middleware.map((item) => item.name);
  }
}

// #region arrow
export const arrow = defineBuilderConfig({
  name: 'FactoryArrow',
  injections: [
    {
      token: useInterface<IConfig>(),
      useFactory: true,
      dependencies: [], // required in strict validation, even when the list is empty
      provider: () => ({ apiUrl: 'http://localhost', timeout: 5000 }),
    },
  ],
});
// #endregion arrow

// #region with-dependencies
export const withDependencies = defineBuilderConfig({
  name: 'FactoryWithDependencies',
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    {
      token: useInterface<IConfig>(),
      useFactory: true,
      dependencies: [],
      provider: () => ({ apiUrl: 'http://localhost', timeout: 5000 }),
    },
    {
      token: useInterface<IHttpClient>(),
      useFactory: true,
      dependencies: [useInterface<IConfig>(), useInterface<ILogger>()],
      provider: (context) => {
        const config = context.resolve(useInterface<IConfig>());
        const logger = context.resolve(useInterface<ILogger>());
        return new HttpClient(logger, config.apiUrl);
      },
    },
  ],
});
// #endregion with-dependencies

// #region named-function
function createDatabaseConnection(context: FactoryContext): IDatabase {
  const config = context.resolve(useInterface<IDbConfig>());
  return new DatabaseConnection(config.connectionString);
}

export const namedFunction = defineBuilderConfig({
  name: 'FactoryNamed',
  injections: [
    { token: useInterface<IDbConfig>(), useValue: { connectionString: 'db://main' } },
    {
      token: useInterface<IDatabase>(),
      provider: createDatabaseConnection,
      useFactory: true,
      dependencies: [useInterface<IDbConfig>()],
    },
  ],
});
// #endregion named-function

// #region existing-instance
class SomeConcreteClass {
  constructor(readonly label: string) {}
}

const someInstance = new SomeConcreteClass('prebuilt');

export const existingInstance = defineBuilderConfig({
  name: 'FactoryExistingInstance',
  injections: [
    { token: SomeConcreteClass, provider: () => someInstance, useFactory: true, dependencies: [] },
  ],
});
// #endregion existing-instance

// #region properties
class ApiService {
  constructor(
    readonly apiUrl: string,
    readonly timeout: number,
    readonly retryCount: number,
  ) {}

  describe(): string {
    return `${this.apiUrl} ${this.timeout} ${this.retryCount}`;
  }
}

const apiUrl = useProperty<string>(ApiService, 'apiUrl');
const timeout = useProperty<number>(ApiService, 'timeout');
const retryCount = useProperty<number>(ApiService, 'retryCount');

export const properties = defineBuilderConfig({
  name: 'FactoryProperties',
  injections: [
    { token: apiUrl, useFactory: true, dependencies: [], provider: () => 'https://api.example.com' },
    { token: timeout, useFactory: true, dependencies: [], provider: () => 5000 },
    { token: retryCount, useFactory: true, dependencies: [], provider: () => 3 },
    { token: ApiService }, // all three primitives are injected
  ],
});
// #endregion properties

// #region transient
let requestCount = 0;

export const transient = defineBuilderConfig({
  name: 'FactoryTransient',
  injections: [
    {
      token: useInterface<IRequest>(),
      useFactory: true,
      dependencies: [],
      provider: () => ({ id: `request-${(requestCount += 1)}` }),
      lifecycle: 'transient',
    },
  ],
});
// #endregion transient

// #region typed-factory
const loggedConfig: Factory<ILoggedConfig> = (context) => ({
  apiUrl: 'http://localhost',
  logger: context.resolve(useInterface<ILogger>()),
});

export const typedFactory = defineBuilderConfig({
  name: 'FactoryTyped',
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    {
      token: useInterface<ILoggedConfig>(),
      useFactory: true,
      dependencies: [useInterface<ILogger>()],
      provider: loggedConfig,
    },
  ],
});
// #endregion typed-factory

// #region all-dependency
export const allDependency = defineBuilderConfig({
  name: 'FactoryAll',
  injections: [
    { token: useInterface<IMiddleware>(), multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'auth' }) },
    { token: useInterface<IMiddleware>(), multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'log' }) },
    {
      token: Pipeline,
      useFactory: true,
      dependencies: [{ all: useInterface<IMiddleware>() }], // `all` asks for resolveAll
      provider: (context) => new Pipeline(context.resolveAll(useInterface<IMiddleware>())),
    },
  ],
});
// #endregion all-dependency

// #region combined
class ApiClientService {
  constructor(
    private logger: ILogger,
    private http: IHttpClient,
    private baseUrl: string,
    private pause: number,
  ) {}

  describe(): string {
    return `${this.logger.kind} ${this.baseUrl} ${this.pause}`;
  }
}

const baseUrl = useProperty<string>(ApiClientService, 'baseUrl');
const pause = useProperty<number>(ApiClientService, 'pause');

export const combined = defineBuilderConfig({
  name: 'AppContainer',
  injections: [
    // Interface binding
    { token: useInterface<ILogger>(), provider: ConsoleLogger },

    // Factory for complex initialization
    {
      token: useInterface<IHttpClient>(),
      useFactory: true,
      dependencies: [useInterface<ILogger>()],
      provider: (context) => {
        const logger = context.resolve(useInterface<ILogger>());
        return new HttpClient(logger, 'http://localhost');
      },
    },

    // Primitive values
    { token: baseUrl, useFactory: true, dependencies: [], provider: () => 'http://localhost' },
    { token: pause, useFactory: true, dependencies: [], provider: () => 5000 },

    // Service with mixed dependencies
    { token: ApiClientService },
  ],
});
// #endregion combined

export async function run() {
  const first = transient.resolve(useInterface<IRequest>()).id;
  const second = transient.resolve(useInterface<IRequest>()).id;
  const typed = typedFactory.resolve(useInterface<ILoggedConfig>());
  const result = {
    arrow: arrow.resolve(useInterface<IConfig>()).apiUrl,
    withDependencies: withDependencies.resolve(useInterface<IHttpClient>()).describe(),
    namedFunction: namedFunction.resolve(useInterface<IDatabase>()).status(),
    existingInstance: existingInstance.resolve(SomeConcreteClass).label,
    properties: properties.resolve(ApiService).describe(),
    transient: [first, second],
    typedFactory: `${typed.apiUrl} logs through ${typed.logger.kind}`,
    allDependency: allDependency.resolve(Pipeline).names(),
    combined: combined.resolve(ApiClientService).describe(),
  };
  for (const container of [arrow, withDependencies, namedFunction, existingInstance, properties, transient, typedFactory, allDependency, combined]) {
    await container.destroy();
  }
  return result;
}
