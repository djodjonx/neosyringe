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
});
