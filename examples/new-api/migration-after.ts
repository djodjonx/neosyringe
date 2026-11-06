import { defineBuilderConfig } from '@djodjonx/neosyringe';

class Database {
  static closed = 0;

  label(): string {
    return 'real';
  }

  dispose(): void {
    Database.closed += 1;
  }
}

class FakeDatabase extends Database {
  label(): string {
    return 'fake';
  }
}

class Report {
  constructor(readonly db: Database) {}

  summary(): string {
    return `report from ${this.db.label()}`;
  }
}

class Settings {
  endpoint = '/api';
}

let clientsClosed = 0;

class Client {
  constructor(readonly endpoint: string) {}

  async dispose(): Promise<void> {
    clientsClosed += 1;
  }
}

class Logger {
  static closed = 0;

  prefix(): string {
    return 'parent';
  }

  dispose(): void {
    Logger.closed += 1;
  }
}

class Handler {
  constructor(readonly logger: Logger) {}

  line(): string {
    return `${this.logger.prefix()} handled`;
  }
}

// #region container
// Candidate shape: every resolution a factory makes is declared.
// One singleton, one async factory, one parent with its child.
export const container = defineBuilderConfig({
  name: 'LegacyApp',
  injections: [
    { token: Database },
    {
      token: Report,
      useFactory: true,
      dependencies: [Database],
      provider: (context) => new Report(context.resolve(Database)),
    },
  ],
});

export const asyncApp = defineBuilderConfig({
  name: 'LegacyAsync',
  injections: [
    { token: Settings },
    {
      token: Client,
      useFactory: true,
      dependencies: [Settings],
      provider: async (context) => {
        const endpoint = context.resolve(Settings).endpoint;
        await Promise.resolve();
        return new Client(endpoint);
      },
    },
  ],
});

export const parent = defineBuilderConfig({
  name: 'LegacyParent',
  injections: [{ token: Logger }],
});

export const child = defineBuilderConfig({
  name: 'LegacyChild',
  useContainer: parent,
  injections: [
    {
      token: Handler,
      useFactory: true,
      dependencies: [Logger],
      provider: (context) => new Handler(context.resolve(Logger)),
    },
  ],
});
// #endregion container

function codeOf(error: unknown): string {
  return error instanceof Error ? error.message.split(':')[0] : String(error);
}

// #region run
export async function run() {
  // Singleton and test override.
  const real = container.resolve(Report).summary();

  // Candidate: wait for the reconfiguration. It needs the plugin option `testOverrides: true`.
  await container.override(Database, () => new FakeDatabase());
  const mocked = container.resolve(Report).summary();
  await container.clearOverrides();
  const restored = container.resolve(Report).summary();
  await container.destroy();
  let afterDestroy = 'no error';
  try {
    container.resolve(Report);
  } catch (error) {
    afterDestroy = codeOf(error);
  }

  // Async factory: initialize once, resolve synchronously, destroy closes the client.
  let asyncBeforeInit = 'no error';
  try {
    asyncApp.resolve(Client);
  } catch (error) {
    asyncBeforeInit = codeOf(error);
  }
  await asyncApp.initialize();
  const asyncEndpoint = asyncApp.resolve(Client).endpoint;
  await asyncApp.destroy();
  let asyncAfterDestroy = 'no error';
  try {
    asyncApp.resolve(Client);
  } catch (error) {
    asyncAfterDestroy = codeOf(error);
  }

  // Parent and child: the child reads the parent's Logger and never closes it.
  const sharedLogger = child.resolve(Handler).logger === parent.resolve(Logger);
  const childLine = child.resolve(Handler).line();
  await child.destroy();
  const parentClosedAfterChild = Logger.closed;
  await parent.destroy();

  return {
    real,
    mocked,
    restored,
    disposed: Database.closed,
    afterDestroy,
    asyncBeforeInit,
    asyncEndpoint,
    asyncClosed: clientsClosed,
    asyncAfterDestroy,
    childLine,
    sharedLogger,
    parentClosedAfterChild,
    parentClosedAfterParent: Logger.closed,
  };
}
// #endregion run
