import { defineBuilderConfig } from '@djodjonx/neosyringe';

export class SharedRepo {
  find(id: string) { return { id }; }
}

export const parentContainer = defineBuilderConfig({
  injections: [{ token: SharedRepo }],
});
