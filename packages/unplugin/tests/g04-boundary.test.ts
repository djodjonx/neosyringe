import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HashUtils } from '@djodjonx/neosyringe-core/analyzer';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { neoSyringePlugin } from '../src/index';

/**
 * Topic 04: a package linked into node_modules by a symlink keeps its node_modules path. The token boundary
 * keys on `/node_modules/` in the path TypeScript resolved, so a session that follows the link to its real
 * folder (outside any node_modules) would read the package as project source and skip the boundary.
 * Seen through the public plugin hooks only, like `g04-session.test.ts`.
 */

const ROOT = repoRoot();
const dirs: string[] = [];
const opened: object[] = [];
let cwdToRestore: string | undefined;

afterEach(() => {
  for (const plugin of opened.splice(0)) callHook(plugin, 'closeWatcher', { meta: { watchMode: false } }, []);
  if (cwdToRestore !== undefined) {
    process.chdir(cwdToRestore);
    cwdToRestore = undefined;
  }
  TSContext.reset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoRoot(): string {
  let dir = path.resolve(process.cwd());
  for (;;) {
    try {
      readFileSync(path.join(dir, 'pnpm-workspace.yaml'));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error('racine du dépôt introuvable');
      dir = parent;
    }
  }
}

/** The temp directory is resolved first: macOS keeps `/var` as a link to `/private/var`, which would hide the link under test. */
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

function callHook(plugin: object, name: string, context: object, args: unknown[]): unknown {
  const hook: unknown = Reflect.get(plugin, name);
  if (typeof hook !== 'function') return undefined;
  return Reflect.apply(hook, context, args);
}

/** The code a transform returns, or `error: <message>` when it throws. */
function transformOutcome(project: string, file: string): string {
  const plugin = neoSyringePlugin.vite({ project });
  opened.push(plugin);
  const source = readFileSync(file, 'utf8');
  try {
    const result = callHook(plugin, 'transform', {}, [source, file]);
    if (typeof result === 'string') return result;
    if (typeof result === 'object' && result !== null && 'code' in result && typeof result.code === 'string') return result.code;
    return source;
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const CONSUMER = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
import type { User } from '@acme/tokens';
export const c = defineBuilderConfig({
  injections: [{ token: useInterface<User>(), useValue: { id: 1 } }],
});
`;

/**
 * A project whose `node_modules/@acme/tokens` is a link to a folder next to it, outside any node_modules. The package
 * depends on NeoSyringe, so it is a producer: with no tokens manifest its tokens are refused
 * (`packages/core/src/analyzer/shared/tokensManifest.ts:293-298`, `:318-331`).
 */
function linkedProject(prefix: string, packageJson: Record<string, unknown>, extra: Record<string, string> = {}): { dir: string; project: string } {
  const dir = tempDir(prefix);
  writeFiles(dir, {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noLib: true,
        types: [],
        skipLibCheck: true,
        baseUrl: '.',
        paths: { '@djodjonx/neosyringe': [path.join(ROOT, 'packages/neosyringe/src/index.ts')] },
      },
      include: ['src/**/*.ts'],
    }),
    'src/app.ts': CONSUMER,
    'shipped-tokens/package.json': JSON.stringify({ name: '@acme/tokens', version: '1.0.0', types: './index.d.ts', dependencies: { '@djodjonx/neosyringe': '*' }, ...packageJson }),
    'shipped-tokens/index.d.ts': 'export interface User { id: number }\n',
    ...Object.fromEntries(Object.entries(extra).map(([name, text]) => [`shipped-tokens/${name}`, text])),
  });
  mkdirSync(path.join(dir, 'node_modules/@acme'), { recursive: true });
  symlinkSync(path.join(dir, 'shipped-tokens'), path.join(dir, 'node_modules/@acme/tokens'));
  return { dir, project: path.join(dir, 'tsconfig.json') };
}

describe('G04 symlinked package and the token boundary', () => {
  it('G04-P25 a token type of a linked package with no tokens manifest is refused at the boundary', () => {
    const { dir, project } = linkedProject('g04-p25-', {});
    cwdToRestore = process.cwd();
    process.chdir(dir);
    const result = transformOutcome(project, path.join(dir, 'src/app.ts'));
    expect(result).toMatch(/^error: /);
    expect(result).toContain('NEO_TOKEN_BOUNDARY_UNSUPPORTED');
    expect(result).toContain('manifest-absent');
  });

  it('G04-P26 the same linked package with a tokens manifest is accepted, and the key comes from its node_modules path', () => {
    const descriptor = 'v1|named|pkg/@acme/tokens/index.d.ts|User|';
    const key = `User_${HashUtils.hashDescriptor(descriptor)}`;
    const { dir, project } = linkedProject('g04-p26-', { neosyringe: { tokensManifest: './tokens-manifest.json' } }, {
      'token.d.ts': 'export declare const UserToken: unique symbol;\n',
      'tokens-manifest.json': JSON.stringify({
        schemaVersion: 1,
        packageName: '@acme/tokens',
        contractVersion: 'contract-a',
        tokens: [{
          exportPath: 'token.d.ts',
          exportName: 'UserToken',
          runtimeKey: key,
          descriptor,
          typeExport: { exportPath: 'index.d.ts', exportName: 'User' },
        }],
      }),
    });
    cwdToRestore = process.cwd();
    process.chdir(dir);
    const result = transformOutcome(project, path.join(dir, 'src/app.ts'));
    expect(result).not.toMatch(/^error: /);
    expect(result).toContain(key);
  });
});
