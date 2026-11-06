import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface Logger {
  name(): string;
}

class RealLogger implements Logger {
  name(): string {
    return 'real';
  }
}

class FakeLogger implements Logger {
  name(): string {
    return 'fake';
  }
}

// #region containers
// The consumer under test: it keeps the Logger it was built with.
export class Service {
  constructor(readonly logger: Logger) {}
}

const logger = useInterface<Logger>();

export const parent = defineBuilderConfig({
  name: 'Parent',
  injections: [
    { token: logger, provider: RealLogger },
    { token: Service },
  ],
});

// Shadow the Logger AND register the consumer here: only a Service built by
// this container sees the fake.
export const child = defineBuilderConfig({
  name: 'Child',
  useContainer: parent,
  injections: [
    { token: logger, provider: FakeLogger, scoped: true },
    { token: Service, scoped: true },
  ],
});

export const app = defineBuilderConfig({
  name: 'App',
  injections: [
    { token: logger, provider: RealLogger },
    { token: Service },
  ],
});
// #endregion containers

// `override` needs the plugin option `testOverrides: true`. It is awaited, and it
// rebuilds every cache of this container: Service is built again around the mock.
export async function run() {
  const fromChild = child.resolve(Service).logger.name();
  const fromParent = parent.resolve(Service).logger.name();

  const before = app.resolve(Service);
  await app.override(logger, () => new FakeLogger());
  const during = app.resolve(Service);
  await app.clearOverrides();
  const after = app.resolve(Service);

  const result = {
    fromChild,
    fromParent,
    seen: [before.logger.name(), during.logger.name(), after.logger.name()],
    consumerRebuilt: before !== during && during !== after,
  };
  await child.destroy();
  await app.destroy();
  await parent.destroy();
  return result;
}
