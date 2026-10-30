import { describe, expect, it } from 'vitest';
import { executeFixture } from './helpers/execute-fixture';

const ALIAS = `
import { defineBuilderConfig as builder } from '@djodjonx/neosyringe';

let constructed = 0;

class Service {
  constructor() {
    constructed += 1;
  }
}

export const c = builder({
  injections: [{ token: Service }],
});

export function run() {
  const before = constructed;
  const first = c.resolve(Service);
  const second = c.resolve(Service);
  return { same: first === second, constructed: constructed - before };
}
`;

const NAMESPACE = `
import * as neo from '@djodjonx/neosyringe';

interface IPort { id: number }
class Impl implements IPort { id = 7; }
class Api { constructor(public url: string) {} }

const URL = neo.useProperty<string>(Api, 'url');

export const c = neo.defineBuilderConfig({
  injections: [
    { token: neo.useInterface<IPort>(), provider: Impl },
    { token: URL, provider: () => 'https://example.test' },
    { token: Api },
  ],
});

export function run() {
  return {
    id: c.resolve(neo.useInterface<IPort>()).id,
    url: c.resolve(URL),
  };
}
`;

const HOMONYM = `
function defineBuilderConfig(config: { injections: unknown[] }) {
  return { business: true, size: config.injections.length };
}

export const c = defineBuilderConfig({ injections: [1] });

export function run() {
  return c;
}
`;

const PROPERTY_CONST = `
import { defineBuilderConfig, useProperty } from '@djodjonx/neosyringe';

class Api {
  constructor(public url: string) {}
}

const URL = useProperty<string>(Api, 'url');

export const c = defineBuilderConfig({
  injections: [
    { token: URL, provider: () => 'https://example.test' },
    { token: Api },
  ],
});

export function run() {
  return c.resolve(URL);
}
`;

describe('T01 symboles et marqueurs', () => {
  it('T01-P1-alias', async () => {
    const outcome = await executeFixture(ALIAS);
    expect(outcome.phase).toBe('ok');
    expect(outcome.phase === 'ok' ? outcome.value : undefined).toEqual({ same: true, constructed: 1 });
  });

  it('T01-P2-namespace', async () => {
    const outcome = await executeFixture(NAMESPACE);
    expect(outcome.phase).toBe('ok');
    expect(outcome.phase === 'ok' ? outcome.value : undefined).toEqual({
      id: 7,
      url: 'https://example.test',
    });
  });

  it('T01-P3-homonym', async () => {
    const outcome = await executeFixture(HOMONYM);
    expect(outcome.phase).toBe('ok');
    expect(outcome.phase === 'ok' ? outcome.transformed : true).toBe(false);
    expect(outcome.phase === 'ok' ? outcome.value : undefined).toEqual({ business: true, size: 1 });
  });

  it('T01-P4-property-const', async () => {
    const outcome = await executeFixture(PROPERTY_CONST);
    expect(outcome.phase).toBe('ok');
    expect(outcome.phase === 'ok' ? outcome.value : undefined).toBe('https://example.test');
  });
});
