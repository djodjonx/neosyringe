import { defineBuilderConfig, type Token } from '@djodjonx/neosyringe';

class Mail {
  send(): string {
    return 'sent';
  }
}
interface Clock {
  now(): number;
}

export const box = defineBuilderConfig({
  name: 'OverrideManyNegative',
  injections: [{ token: Mail }],
});

export const minimal = defineBuilderConfig({
  name: 'OverrideManyMinimal',
  runtime: { profile: 'minimal' },
  injections: [{ token: Mail }],
});

// A factory that returns the wrong type for its token.
box.overrideMany([[Mail, () => 42]]);
// A union of pairs, one of them incoherent: a token of Clock with a factory of Mail.
declare const incoherent: ReadonlyArray<readonly [typeof Mail, () => Mail] | readonly [Token<Clock>, () => Mail]>;
box.overrideMany(incoherent);
// A value that is not a token.
box.overrideMany([[42, () => 1]]);
// The minimal profile has no overrideMany.
minimal.overrideMany([]);
