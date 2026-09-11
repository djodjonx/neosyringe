import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

export interface Logger { log(msg: string): string; }
export class ConsoleLogger implements Logger { log(msg: string) { return `console:${msg}`; } }

export const parentContainer = defineBuilderConfig({
  injections: [{ token: useInterface<Logger>(), provider: ConsoleLogger }],
});
