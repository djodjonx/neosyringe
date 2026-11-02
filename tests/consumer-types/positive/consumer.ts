import { defineBuilderConfig, useInterface, type Lifecycle } from '@djodjonx/neosyringe';

const lifecycle: Lifecycle = 'singleton';

interface BorrowedPort {
  id: number;
}

const borrowedPort = useInterface<BorrowedPort>();

export const container = defineBuilderConfig({
  name: 'PositiveConsumer',
  injections: [
    {
      token: borrowedPort,
      useFactory: true,
      dependencies: [],
      ownership: 'borrowed',
      provider: () => ({ id: 1 }),
    },
  ],
});

export const checked: Lifecycle = lifecycle;
