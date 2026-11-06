import { describe, expect, it, vi } from 'vitest';
import { executeFixture } from './helpers/execute-fixture';

const KNOWN_MISSING = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';

class Present {}
class MissingToken {}

export const c = defineBuilderConfig({
  injections: [{ token: Present }],
});

export function run() {
  return c.resolve(MissingToken);
}
`;

const UNDECIDABLE = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';

class Present {}
class MissingToken {}

export const c = defineBuilderConfig({
  injections: [{ token: Present }],
});

export function run() {
  const get = () => c;
  return get().resolve(MissingToken);
}
`;

const CHILD_SCOPES = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';

class Shared {}
class Local {}

export const root = defineBuilderConfig({
  injections: [{ token: Shared }],
});

export const child = defineBuilderConfig({
  useContainer: root,
  injections: [{ token: Local }],
});
`;

const SCOPE_PAIR = `
${CHILD_SCOPES}
export async function run() {
  const scope1 = child.createScope();
  const scope2 = child.createScope();
  const rootA = root.createScope();
  const rootB = root.createScope();
  const value = {
    local1: scope1.resolve(Local),
    local2: scope2.resolve(Local),
    shared1: scope1.resolve(Shared),
    shared2: scope2.resolve(Shared),
    rootShared1: rootA.resolve(Shared),
    rootShared2: rootB.resolve(Shared),
  };
  await scope1.destroy();
  await scope2.destroy();
  await rootA.destroy();
  await rootB.destroy();
  await child.destroy();
  await root.destroy();
  return value;
}
`;

const SCOPE_OF_SCOPE = `
${CHILD_SCOPES}
export async function run() {
  const scope = child.createScope();
  const inner1 = scope.createScope();
  const inner2 = scope.createScope();
  const value = {
    local1: inner1.resolve(Local),
    local2: inner2.resolve(Local),
    shared1: inner1.resolve(Shared),
    shared2: inner2.resolve(Shared),
  };
  await inner1.destroy();
  await inner2.destroy();
  await scope.destroy();
  await child.destroy();
  await root.destroy();
  return value;
}
`;

const SCOPE_MISSING = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';

class Present {}
class Unregistered {}

export const c = defineBuilderConfig({
  injections: [{ token: Present }],
});

export function run() {
  return c.createScope().resolve(Unregistered);
}
`;

const SCOPE_GET = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';

class Present {}

export const c = defineBuilderConfig({
  injections: [{ token: Present }],
});

export function run() {
  const get = () => c;
  return get().createScope().resolve(Present);
}
`;

const SCOPE_OPTIONAL = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';

class Present {}

export const container = defineBuilderConfig({
  injections: [{ token: Present }],
});

export function run() {
  const scope = container.createScope?.();
  if (scope === undefined) return 'missing';
  return scope.resolve(Present) instanceof Present;
}
`;

interface ScopeIdentities {
  local1: object;
  local2: object;
  shared1: object;
  shared2: object;
  rootShared1?: object;
  rootShared2?: object;
}

describe('T06 e2e usages', () => {
  it('T06 strict build rejects resolve of a missing token on a known container', async () => {
    const outcome = await executeFixture(KNOWN_MISSING);
    expect(outcome.phase).toBe('build');
    const diagnostic = outcome.phase === 'build' ? outcome.diagnostic : '';
    expect(diagnostic).toContain('NEO_MISSING_PROVIDER');
  });

  it('T06 compatible undecidable receiver reaches the runtime guard', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const outcome = await executeFixture(UNDECIDABLE, { validation: 'compatible' });
      expect(outcome.phase).toBe('runtime');
      const error = outcome.phase === 'runtime' ? outcome.error : '';
      expect(error).toContain('Service not found or token not registered: MissingToken');
      const warned = warn.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
      expect(warned).toContain('NEO_UNKNOWN_CONTAINER');
      expect(warned).toMatch(/:\d+:\d+/);
    } finally {
      warn.mockRestore();
    }
  });

  it('T06-A06 resolveAll on a single token builds and returns nothing', async () => {
    const source = `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      class Present {}
      export const c = defineBuilderConfig({ injections: [{ token: Present }] });
      export function run() { return c.resolveAll(Present); }
    `;
    const outcome = await executeFixture(source);
    expect(outcome.phase).toBe('ok');
    expect(outcome.phase === 'ok' ? outcome.value : undefined).toEqual([]);
  });

  it('T06-A06 resolveAll on an absent token builds and returns nothing', async () => {
    const source = `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      class Present {}
      class MissingToken {}
      export const c = defineBuilderConfig({ injections: [{ token: Present }] });
      export function run() { return c.resolveAll(MissingToken); }
    `;
    const outcome = await executeFixture(source);
    expect(outcome.phase).toBe('ok');
    expect(outcome.phase === 'ok' ? outcome.value : undefined).toEqual([]);
  });

  it('T06-A06 resolve on a multi token fails the build', async () => {
    const source = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      interface IPlugin { id: number }
      class AuthPlugin implements IPlugin { id = 1; }
      class LogPlugin implements IPlugin { id = 2; }
      export const c = defineBuilderConfig({
        injections: [
          { token: useInterface<IPlugin>(), provider: AuthPlugin, multi: true },
          { token: useInterface<IPlugin>(), provider: LogPlugin, multi: true },
        ],
      });
      export function run() { return c.resolve(useInterface<IPlugin>()); }
    `;
    const outcome = await executeFixture(source);
    expect(outcome.phase).toBe('build');
    const diagnostic = outcome.phase === 'build' ? outcome.diagnostic : '';
    expect(diagnostic).toContain('NEO_MULTI_REQUIRES_RESOLVE_ALL');
  });

  it('T06-A06 resolveAll on a multi token builds', async () => {
    const source = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      interface IPlugin { id: number }
      class AuthPlugin implements IPlugin { id = 1; }
      class LogPlugin implements IPlugin { id = 2; }
      export const c = defineBuilderConfig({
        injections: [
          { token: useInterface<IPlugin>(), provider: AuthPlugin, multi: true },
          { token: useInterface<IPlugin>(), provider: LogPlugin, multi: true },
        ],
      });
      export function run() {
        return c.resolveAll(useInterface<IPlugin>()).map((plugin: IPlugin) => plugin.id);
      }
    `;
    const outcome = await executeFixture(source);
    expect(outcome.phase).toBe('ok');
    expect(outcome.phase === 'ok' ? outcome.value : undefined).toEqual([1, 2]);
  });

  it('strict createScope resolve builds and runs', async () => {
    const outcome = await executeFixture(SCOPE_PAIR);
    expect(outcome.phase, JSON.stringify(outcome)).toBe('ok');
    if (outcome.phase !== 'ok') return;
    const value = outcome.value as ScopeIdentities;
    expect(value.local1).not.toBe(value.local2);
    expect(value.shared1).toBe(value.shared2);
    expect(value.rootShared1).not.toBe(value.rootShared2);
  });

  it('strict scope of a scope', async () => {
    const outcome = await executeFixture(SCOPE_OF_SCOPE);
    expect(outcome.phase, JSON.stringify(outcome)).toBe('ok');
    if (outcome.phase !== 'ok') return;
    const value = outcome.value as ScopeIdentities;
    expect(value.local1).not.toBe(value.local2);
    expect(value.shared1).toBe(value.shared2);
  });

  it('strict scope.resolve(Unregistered)', async () => {
    const outcome = await executeFixture(SCOPE_MISSING);
    expect(outcome.phase).toBe('build');
    const diagnostic = outcome.phase === 'build' ? outcome.diagnostic : '';
    expect(diagnostic).toContain("NEO_MISSING_PROVIDER: 'Unregistered'");
  });

  it('undecidable get().createScope().resolve(X)', async () => {
    const outcome = await executeFixture(SCOPE_GET);
    expect(outcome.phase).toBe('build');
    const diagnostic = outcome.phase === 'build' ? outcome.diagnostic : '';
    expect(diagnostic).toContain('NEO_UNKNOWN_CONTAINER: resolve receiver is not a known container');
  });

  it('strict createScope?.() resolve builds and runs', async () => {
    const outcome = await executeFixture(SCOPE_OPTIONAL);
    expect(outcome.phase, JSON.stringify(outcome)).toBe('ok');
    if (outcome.phase !== 'ok') return;
    expect(outcome.value).toBe(true);
  });
});
