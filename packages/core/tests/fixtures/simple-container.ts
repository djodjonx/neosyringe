import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface ILogger {
  log(msg: string): void;
}

class ConsoleLogger implements ILogger {
  log(_msg: string): void {}
}

class UserService {
  constructor(private logger: ILogger) {}
}

export const container = defineBuilderConfig({
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: UserService }
  ]
});

