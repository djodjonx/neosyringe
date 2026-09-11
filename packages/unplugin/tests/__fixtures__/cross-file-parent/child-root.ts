import { defineBuilderConfig } from '@djodjonx/neosyringe';
import { parentContainer, type Logger } from './parent-root';

export class ConsumerA {
  constructor(private readonly logger: Logger) {}
  run() { return this.logger.log('A'); }
}

export const childContainer = defineBuilderConfig({
  useContainer: parentContainer,
  injections: [{ token: ConsumerA }],
});
