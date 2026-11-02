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

interface ClosedPort {
  ok: number;
}

interface ClosedExtra {
  n: number;
}

const closedPort = useInterface<ClosedPort>();
const closedExtra = useInterface<ClosedExtra>();

export const closedContainer = defineBuilderConfig({
  name: 'ClosedConsumer',
  optimization: {
    mode: 'closed',
    roots: [closedPort, { all: closedExtra }],
    eager: [closedPort],
  },
  injections: [
    {
      token: closedPort,
      useFactory: true,
      dependencies: [],
      provider: () => ({ ok: 1 }),
    },
  ],
});
