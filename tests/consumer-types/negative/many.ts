import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

class Mail {}
interface Clock {
  now(): number;
}
const clock = useInterface<Clock>();

export const box = defineBuilderConfig({
  name: 'ManyNegative',
  injections: [{ token: Mail }],
});

// A value that is not a token.
box.resolveMany([42]);
// A tuple whose first element has the wrong value type.
export const wrong: [number, Clock] = box.resolveMany([Mail, clock]);
