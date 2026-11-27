import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface Logger {
  log(message: string): string;
}

interface Named {
  log(message: string): string;
  name: string;
}

class ConsoleLogger implements Named {
  readonly name = 'console';
  readonly lines: string[] = [];

  log(message: string): string {
    this.lines.push(message);
    return `${this.name}: ${message}`;
  }
}

class Reporter {
  constructor(readonly logger: Logger) {}
}

const logger = useInterface<Logger>();
const named = useInterface<Named>();

// #region container
export const container = defineBuilderConfig({
  name: 'AliasApp',
  injections: [
    { token: ConsoleLogger },
    { token: named, useExisting: ConsoleLogger },
    // An alias of an alias is one read.
    { token: logger, useExisting: named },
    { token: Reporter },
  ],
});
// #endregion container

export async function run() {
  // #region reads
  // Every token answers the one singleton of the target: the alias builds nothing and caches nothing.
  const direct = container.resolve(ConsoleLogger);
  const viaNamed = container.resolve(named);
  const viaLogger = container.resolve(logger);
  const reporter = container.resolve(Reporter);
  // #endregion reads

  reporter.logger.log('from the reporter');
  const answer: string = viaLogger.log('hello');
  const result = {
    sameInstance: direct === viaNamed && viaNamed === viaLogger,
    reporterSharesIt: reporter.logger === direct,
    answer,
    lines: direct.lines,
  };
  await container.destroy();
  return result;
}
