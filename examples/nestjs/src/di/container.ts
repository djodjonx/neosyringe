import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
import type { ICatRepository } from '../domain/i-cat-repository';
import { InMemoryCatRepository } from '../infrastructure/in-memory-cat.repository';
import { CatsService } from '../domain/cats.service';

export const container = defineBuilderConfig({
  name: 'CatsContainer',
  injections: [
    { token: useInterface<ICatRepository>(), provider: InMemoryCatRepository },
    { token: CatsService },
  ],
});
