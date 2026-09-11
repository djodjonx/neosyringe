import { defineBuilderConfig } from '@djodjonx/neosyringe';
import { parentContainer } from './parent-root';
// Type-only import: SharedRepo must NOT be in the runtime scope of this file —
// the generated factory has to bring its own reference to the class.
import type { SharedRepo } from './parent-root';

export class ConsumerA {
  constructor(private readonly repo: SharedRepo) {}
  run() { return this.repo.find('1'); }
}

export const childContainer = defineBuilderConfig({
  useContainer: parentContainer,
  injections: [{ token: ConsumerA }],
});
