import { beforeAll, describe, expect, it } from 'vitest';
import {
  PARENT_DISPOSE_KEY,
  assertCell,
  cellFromTitle,
  destroyContainers,
  emitProduct,
  finishBuild,
  type ContractCell,
  type Emit,
} from '../helpers/t00-contract';
import { warmLibCache } from '../fastProgram';

function thisCell(): ContractCell {
  const name = expect.getState().currentTestName;
  if (!name) throw new Error('missing test title');
  const mark = name.lastIndexOf(' > ');
  const title = mark < 0 ? name : name.slice(mark + 3);
  return cellFromTitle(title);
}

async function runCell(): Promise<void> {
  const cell = thisCell();
  await assertCell((item) => emitProduct(item, 'optimized'), cell, 'optimized');
  await assertCell((item) => emitProduct(item, 'reference'), cell, 'reference');
}

describe('T00 contract matrix', () => {
  beforeAll(() => {
    warmLibCache();
  });

  it('T00 full open sync root', () => runCell(), 60_000);
  it('T00 full open sync scope', () => runCell(), 60_000);
  it('T00 full open sync parent', () => runCell(), 60_000);
  it('T00 full open async root', () => runCell(), 60_000);
  it('T00 full open async scope', () => runCell(), 60_000);
  it('T00 full open async parent', () => runCell(), 60_000);
  it('T00 full closed sync root', () => runCell(), 60_000);
  it('T00 full closed sync scope', () => runCell(), 60_000);
  it('T00 full closed sync parent', () => runCell(), 60_000);
  it('T00 full closed async root', () => runCell(), 60_000);
  it('T00 full closed async scope', () => runCell(), 60_000);
  it('T00 full closed async parent', () => runCell(), 60_000);
  it('T00 minimal open sync root', () => runCell(), 60_000);
  it('T00 minimal open sync scope', () => runCell(), 60_000);
  it('T00 minimal open sync parent', () => runCell(), 60_000);
  it('T00 minimal open async root', () => runCell(), 60_000);
  it('T00 minimal open async scope', () => runCell(), 60_000);
  it('T00 minimal open async parent', () => runCell(), 60_000);
  it('T00 minimal closed sync root', () => runCell(), 60_000);
  it('T00 minimal closed sync scope', () => runCell(), 60_000);
  it('T00 minimal closed sync parent', () => runCell(), 60_000);
  it('T00 minimal closed async root', () => runCell(), 60_000);
  it('T00 minimal closed async scope', () => runCell(), 60_000);
  it('T00 minimal closed async parent', () => runCell(), 60_000);

  it('destroys containers opened before a failed build', async () => {
    let destroyed = 0;
    const opened: { destroy: () => Promise<void> }[] = [];
    await expect(finishBuild(opened, async () => {
      opened.push({
        destroy: async () => {
          destroyed += 1;
        },
      });
      throw new Error('build failed');
    })).rejects.toThrow('build failed');
    expect(destroyed).toBe(1);
  });

  it('reports a destroy error from a container', async () => {
    const opened = [{
      destroy: async () => {
        throw new Error('disk failed');
      },
    }];
    await expect(destroyContainers(opened)).rejects.toThrow('disk failed');
  });

  it('ignores a destroy that reports the container is already destroyed', async () => {
    const opened = [{
      destroy: async () => {
        const error = new Error('gone');
        Reflect.set(error, 'code', 'NEO_CONTAINER_DESTROYED');
        throw error;
      },
    }];
    await destroyContainers(opened);
    expect(opened).toEqual([]);
  });

  it('clears the dispose counter when building throws', async () => {
    const emit: Emit = async () => {
      Reflect.set(globalThis, PARENT_DISPOSE_KEY, 4);
      throw new Error('build failed');
    };
    await expect(assertCell(emit, cellFromTitle('T00 full open sync root'))).rejects.toThrow('build failed');
    expect(Reflect.get(globalThis, PARENT_DISPOSE_KEY)).toBeUndefined();
  });

  it('clears the dispose counter after the cell', async () => {
    const emit: Emit = async (cell) => {
      const executed = await emitProduct(cell, 'optimized');
      return {
        ...executed,
        close: async () => {
          await executed.close();
          Reflect.set(globalThis, PARENT_DISPOSE_KEY, 5);
        },
      };
    };
    await assertCell(emit, cellFromTitle('T00 full open sync root'));
    expect(Reflect.get(globalThis, PARENT_DISPOSE_KEY)).toBeUndefined();
  }, 60_000);

  it('reports a scope destroy failure', async () => {
    const emit: Emit = async (cell) => {
      const executed = await emitProduct(cell, 'optimized');
      const open = executed.box.createScope.bind(executed.box);
      executed.box.createScope = () => {
        const scope = open();
        const close = scope.destroy.bind(scope);
        scope.destroy = async () => {
          await close();
          throw new Error('scope teardown failed');
        };
        return scope;
      };
      return executed;
    };
    await expect(assertCell(emit, cellFromTitle('T00 full open sync scope'))).rejects.toThrow('scope teardown failed');
  }, 60_000);
});
