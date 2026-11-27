import { defineBuilderConfig, useInterface, useProperty } from '@djodjonx/neosyringe';

class Mailer {
  send(to: string): string {
    return `mail to ${to}`;
  }
}

interface Clock {
  now(): number;
}

const clock = useInterface<Clock>();
const retries = useProperty<number>(Mailer, 'retries');

// #region container
export const container = defineBuilderConfig({
  name: 'ResolveManyApp',
  injections: [
    { token: Mailer },
    { token: clock, useFactory: true, dependencies: [], provider: () => ({ now: () => 1700 }) },
    { token: retries, useFactory: true, dependencies: [], provider: () => 3 },
  ],
});
// #endregion container

export async function run() {
  // #region resolve-many
  // One call, one typed tuple: each position has the type of its token. The list must be a literal.
  const [mailer, time, attempts] = container.resolveMany([Mailer, clock, retries]);
  const sent: string = mailer.send('ana');
  const at: number = time.now();
  const tries: number = attempts;
  // #endregion resolve-many

  const [first, second] = container.resolveMany([Mailer, Mailer]);
  const none = container.resolveMany([]);

  // A scope has the same method, over its own caches.
  const scopeA = container.createScope();
  const scopeB = container.createScope();
  const [fromA] = scopeA.resolveMany([Mailer]);
  const [fromB] = scopeB.resolveMany([Mailer]);
  const scopedOnce = scopeA.resolveMany([Mailer])[0] === fromA;

  await scopeA.destroy();
  await scopeB.destroy();
  await container.destroy();
  return {
    sent,
    at,
    tries,
    sameInstance: first === second,
    empty: none.length,
    scopesIsolated: fromA !== fromB,
    scopedOnce,
  };
}
