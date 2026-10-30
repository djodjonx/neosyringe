import { defineBuilderConfig, type Lifecycle } from '@djodjonx/neosyringe';

const lifecycle: Lifecycle = 'singleton';

export const container = defineBuilderConfig({
  name: 'PositiveConsumer',
  injections: [],
});

export const checked: Lifecycle = lifecycle;
