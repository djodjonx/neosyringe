import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactDescriptor,
  artifactId,
  CollisionRegistry,
  resolveArtifactIdentity,
  type ArtifactIdentity,
} from '../../src/analyzer/shared/artifactIdentity';
import type { DependencyGraph } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { TSContext } from '../../src/TSContext';

const MESSAGE = 'stable project-relative identity required';
const scratch: string[] = [];

function identity(relativeFile: string, projectId = 'fixture-app', declarationId = 'container:App'): ArtifactIdentity {
  return { projectId, relativeFile, declarationId };
}

function keep(dir: string): string {
  scratch.push(dir);
  return dir;
}

function graphAt(file: string, containerId: string): DependencyGraph {
  return {
    containerId,
    nodes: new Map(),
    roots: [],
    sourceFileName: file,
    defineBuilderConfigStart: 1,
  };
}

describe('artifact identity', () => {
  afterEach(() => {
    TSContext.reset();
    while (scratch.length > 0) {
      const dir = scratch.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('artifactDescriptor rejects an absolute path', () => {
    expect(() => artifactDescriptor(identity('/src/app.ts'))).toThrow(MESSAGE);
  });

  it('artifactDescriptor rejects a parent segment', () => {
    expect(() => artifactDescriptor(identity('src/../app.ts'))).toThrow(MESSAGE);
  });

  it('artifactDescriptor rejects a dot segment', () => {
    expect(() => artifactDescriptor(identity('src/./app.ts'))).toThrow(MESSAGE);
  });

  it('artifactDescriptor rejects a drive-letter path', () => {
    expect(() => artifactDescriptor(identity('C:/src/app.ts'))).toThrow(MESSAGE);
  });

  it('artifactDescriptor accepts an unrooted absolute marker', () => {
    const posix = artifactDescriptor(identity('unrooted:/abs/a.ts'));
    const drive = artifactDescriptor(identity('unrooted:C:/proj/a.ts'));
    expect(posix).toBe(JSON.stringify(['neo-artifact-v1', 'fixture-app', 'unrooted:/abs/a.ts', 'container:App']));
    expect(drive).toBe(JSON.stringify(['neo-artifact-v1', 'fixture-app', 'unrooted:C:/proj/a.ts', 'container:App']));
  });

  it('artifactDescriptor rejects an unrooted marker that is not a clean absolute', () => {
    expect(() => artifactDescriptor(identity('unrooted:Widget.ts'))).toThrow(MESSAGE);
    expect(() => artifactDescriptor(identity('unrooted:'))).toThrow(MESSAGE);
    expect(() => artifactDescriptor(identity('unrooted:C:proj/a.ts'))).toThrow(MESSAGE);
    expect(() => artifactDescriptor(identity('unrooted:/abs/../a.ts'))).toThrow(MESSAGE);
    expect(() => artifactDescriptor(identity('unrooted:/abs/./a.ts'))).toThrow(MESSAGE);
  });

  it('artifactDescriptor rejects an empty id', () => {
    expect(() => artifactDescriptor(identity('src/app.ts', ''))).toThrow(MESSAGE);
    expect(() => artifactDescriptor(identity('src/app.ts', 'fixture-app', ''))).toThrow(MESSAGE);
    expect(() => artifactDescriptor(identity(''))).toThrow(MESSAGE);
  });

  it('artifactId is 24 hex characters and follows the injected hash', () => {
    const id = artifactId(identity('src/app.ts'));
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(artifactId(identity('src/app.ts'))).toBe(id);
    expect(artifactId(identity('src/other.ts'))).not.toBe(id);
    expect(artifactId(identity('src/app.ts'), () => 'same-key')).toBe('same-key');
  });

  it('CollisionRegistry refuses a second descriptor', () => {
    const registry = new CollisionRegistry();
    registry.register('key', 'one');
    registry.register('key', 'one');
    registry.register('other', 'two');
    expect(() => registry.register('key', 'two')).toThrow(/identity collision/);
  });

  it('CollisionRegistry refuses a different source on the same descriptor', () => {
    const registry = new CollisionRegistry();
    registry.bind('/x/Widget.ts');
    registry.register('key', 'same');
    registry.bind('/x/Widget.ts');
    registry.register('key', 'same');
    registry.bind('/y/Widget.ts');
    expect(() => registry.register('key', 'same')).toThrow(/identity collision/);
  });

  it('resolveArtifactIdentity refuses a non-absolute source', () => {
    expect(() => resolveArtifactIdentity({
      sourceFileName: 'src/app.ts',
      defineBuilderConfigStart: 1,
      containerId: 'App',
    })).toThrow(MESSAGE);
  });

  it('resolveArtifactIdentity does not read the process cwd', () => {
    TSContext.reset();
    const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-t10-cwd-')));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-app' }));
    mkdirSync(path.join(root, 'src'));
    const readCwd = process.cwd;
    const calls: string[] = [];
    process.cwd = () => {
      calls.push('cwd');
      return readCwd.call(process);
    };
    try {
      const resolved = resolveArtifactIdentity({
        sourceFileName: path.join(root, 'src', 'app.ts'),
        defineBuilderConfigStart: 4,
        containerId: 'App',
      });
      expect(resolved.projectId).toBe('fixture-app');
      expect(calls).toEqual([]);
    } finally {
      process.cwd = readCwd;
    }
  });

  it('resolveArtifactIdentity uses the package name and refuses a silent parent path', () => {
    const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-t10-id-')));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-app' }));
    const inside = TSContext.runWithProjectRoot(root, () => resolveArtifactIdentity({
      sourceFileName: path.join(root, 'src', 'app.ts'),
      defineBuilderConfigStart: 8,
      containerId: 'App',
    }));
    expect(inside.projectId).toBe('fixture-app');
    expect(inside.relativeFile).toBe('src/app.ts');
    expect(inside.relativeFile).not.toContain('..');
    expect(inside.declarationId).toBe('defineBuilderConfig:8');

    const nestedRoot = path.join(root, 'web');
    const nested = TSContext.runWithProjectRoot(nestedRoot, () => resolveArtifactIdentity({
      sourceFileName: path.join(nestedRoot, 'src', 'app.ts'),
      containerId: 'App',
    }));
    expect(nested.projectId).toBe('fixture-app#web');
    expect(nested.relativeFile).toBe('web/src/app.ts');
    expect(nested.declarationId).toBe('container:App');

    const outside = path.join(tmpdir(), 'neosyringe-t10-elsewhere', 'Widget.ts');
    const escaped = TSContext.runWithProjectRoot(root, () => resolveArtifactIdentity({
      sourceFileName: outside,
      defineBuilderConfigStart: 3,
      containerId: 'App',
    }));
    expect(escaped.relativeFile).toBe(`unrooted:${outside.replaceAll('\\', '/')}`);
    expect(escaped.relativeFile).not.toContain('..');

    const bare = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-t10-local-')));
    const local = TSContext.runWithProjectRoot(bare, () => resolveArtifactIdentity({
      sourceFileName: path.join(bare, 'src', 'app.ts'),
      defineBuilderConfigStart: 2,
      containerId: 'App',
    }));
    expect(local.projectId).toBe('local');
    expect(local.relativeFile).toBe('src/app.ts');
  });

  it('Generator registers an identity collision', () => {
    const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-t10-hit-')));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-app' }));
    const registry = new CollisionRegistry();
    const options = { collisions: registry, hash: () => 'same-key' };
    const generate = (file: string, containerId: string) => {
      new Generator(graphAt(path.join(root, file), containerId), true, undefined, false, false, 'reference', options).generate();
    };
    TSContext.runWithProjectRoot(root, () => {
      generate('src/a.ts', 'A');
      generate('src/a.ts', 'A');
      expect(() => generate('src/b.ts', 'B')).toThrow(/identity collision/);
    });
  });

  it('two unrooted files get different artifact names', () => {
    const project = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-t10-project-')));
    const left = path.join(tmpdir(), 'neosyringe-t10-left', 'Widget.ts');
    const right = path.join(tmpdir(), 'neosyringe-t10-right', 'Widget.ts');
    const resolve = (sourceFileName: string) => TSContext.runWithProjectRoot(project, () => resolveArtifactIdentity({
      sourceFileName,
      defineBuilderConfigStart: 3,
      containerId: 'App',
    }));
    const leftId = resolve(left);
    const rightId = resolve(right);
    expect(leftId.relativeFile).toBe(`unrooted:${left.replaceAll('\\', '/')}`);
    expect(rightId.relativeFile).toBe(`unrooted:${right.replaceAll('\\', '/')}`);
    expect(leftId.relativeFile).not.toBe(rightId.relativeFile);
    const registry = new CollisionRegistry();
    const options = { collisions: registry };
    const emit = (file: string): string => TSContext.runWithProjectRoot(project, () => {
      return new Generator(graphAt(file, 'App'), true, undefined, false, false, 'reference', options).generate();
    });
    const leftCode = emit(left);
    const rightCode = emit(right);
    const suffix = (text: string): string | undefined => text.match(/class NeoContainer_([0-9a-f]{24})/)?.[1];
    expect(suffix(leftCode)).toMatch(/^[0-9a-f]{24}$/);
    expect(suffix(rightCode)).not.toBe(suffix(leftCode));
  });

  it('one unrooted file keeps one descriptor across query and slash variants', () => {
    const project = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-t10-variant-')));
    const resolve = (sourceFileName: string) => TSContext.runWithProjectRoot(project, () => resolveArtifactIdentity({
      sourceFileName,
      defineBuilderConfigStart: 4,
      containerId: 'App',
    }));
    const queryA = resolve('/abs/a.ts?v=1');
    const queryB = resolve('/abs/a.ts?v=2');
    const hashed = resolve('/abs/a.ts#part');
    expect(queryA.relativeFile).toBe('unrooted:/abs/a.ts');
    expect(queryB.relativeFile).toBe(queryA.relativeFile);
    expect(hashed.relativeFile).toBe(queryA.relativeFile);
    const back = resolve('C:\\proj\\a.ts');
    const fwd = resolve('C:/proj/a.ts');
    expect(back.relativeFile).toBe('unrooted:C:/proj/a.ts');
    expect(back.projectId).toBe('local');
    expect(fwd.relativeFile).toBe(back.relativeFile);
    expect(fwd.projectId).toBe(back.projectId);
    const cased = resolve('/Abs/File.ts');
    expect(cased.relativeFile).toBe('unrooted:/Abs/File.ts');
    const dotted = resolve('/abs/foo/../a.ts');
    expect(dotted.relativeFile).toBe('unrooted:/abs/a.ts');
    expect(artifactId(queryA)).toBe(artifactId(queryB));
    expect(artifactId(back)).toBe(artifactId(fwd));
    expect(artifactId(queryA)).not.toBe(artifactId(back));
  });
});
