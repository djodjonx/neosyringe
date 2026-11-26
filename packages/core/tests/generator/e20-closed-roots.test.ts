import { beforeAll, describe, expect, it } from 'vitest';
import { MATRIX, capabilityAlias, containerText, label, readKey, shown, thrown, use, withEnv, type Cell } from '../helpers/e20-build';
import { warmLibCache } from '../fastProgram';

/**
 * Stage D open point, `_singleRoots` against `__neoRoots`, answered on the aliases of a closed container, both emitters
 * and both profiles. `_singleRoots` is what refuses a token that is no root *before* the table or the parent loop is
 * read: a root table has a row for a local provider only, so a token a parent provides would fall through to the parent
 * and be answered, were it not for the set. Every test calls `capabilityAlias` first.
 */

const NOT_EXPORTED = 'NEO_ROOT_NOT_EXPORTED';

const closedSync = (): Cell[] => MATRIX.filter((cell) => cell.mode === 'closed' && cell.timing === 'sync');

describe('E20 closed roots', () => {
  beforeAll(() => {
    warmLibCache();
  });

  it('E20-P24 the roots set of a closed container lists the published alias and is read before anything else', async () => {
    for (const cell of closedSync()) {
      await withEnv(cell, { roots: '[sink]' }, async (env) => {
        capabilityAlias(env.built);
        const name = label(cell);
        const text = containerText(env.built);
        expect(text.match(/_singleRoots = new Set<unknown>\(\[([^\]]*)\]\)/)?.[1], `${name}: the set holds the alias key`).toBe(JSON.stringify(env.sink));
        expect(text, `${name}: the guard reads the set`).toMatch(/\(all \? this\._multiRoots : this\._singleRoots\)\.has\(token\)/);
        expect(readKey(env.read(env.sink), 'id'), `${name}: the root answers`).toBe('engine');
        expect(thrown(() => env.read(env.engine)).code, `${name}: a token that is not a root is refused`).toBe(NOT_EXPORTED);
      });
    }
  }, 240_000);

  it('E20-P24 a token the parent provides is refused by the set when it is not a root of the child, and answered when it is', async () => {
    const parent = "export const parent = defineBuilderConfig({ name: 'E20Parent', injections: [{ token: Engine }] });";
    for (const cell of closedSync()) {
      await withEnv(cell, {
        target: 'none',
        before: parent,
        useContainer: 'useContainer: parent,',
        aliases: '{ token: logger, useExisting: Engine },',
        roots: '[logger]',
        extra: '',
      }, async (env) => {
        capabilityAlias(env.built);
        const name = label(cell);
        const fromParent = use(env.built.box('parent'), 'resolve', env.engine);
        expect(env.read(env.logger), `${name}: the alias root reaches the parent object`).toBe(fromParent);
        const refused = thrown(() => env.read(env.engine));
        expect(refused.code, `${name}: the parent token is no root of the child, the set refuses it`).toBe(NOT_EXPORTED);
        expect(refused.message, `${name}: and says which container`).toContain('E20');
        expect(shown(env.logger), 'the alias is a named token').toBe('Logger');
      });
    }
  }, 240_000);
});
