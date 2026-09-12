import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface ILogger { log(msg: string): void; }
class ConsoleLogger implements ILogger { log(msg: string) {} }

export const container = defineBuilderConfig({
  injections: [{ token: useInterface<ILogger>(), provider: ConsoleLogger }],
});
