import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface BorrowedPort {
  id: number;
}

const borrowedPort = useInterface<BorrowedPort>();

export const container = defineBuilderConfig({
  name: 'NegativeOwnership',
  injections: [
    {
      token: borrowedPort,
      useValue: { id: 1 },
      ownership: 'owned',
    },
  ],
});
