import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';

describe('T01 ts-patch transformer provenance', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('T01-P10-transformer', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-transformer-'));
    dirs.push(dir);
    const barrelPath = path.join(dir, 'barrel.ts');
    const consumerPath = path.join(dir, 'consumer.ts');
    writeFileSync(barrelPath, `export { defineBuilderConfig as builder } from '@djodjonx/neosyringe';\n`);
    writeFileSync(consumerPath, `
import { builder } from './barrel';

class Service {}

export const c = builder({
  injections: [{ token: Service }],
});
`);

    const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) throw new Error('tsconfig.json introuvable');
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, process.cwd());
    const program = ts.createProgram([consumerPath], parsed.options);
    const { default: neoSyringeTransformer } = await import('../src/transformer');
    const next = neoSyringeTransformer(program, undefined, {}, { ts } as never);
    const output = next.getSourceFile(consumerPath)?.text ?? '';
    expect(output).not.toContain('builder(');
    expect(output).toContain('class NeoContainer');
  });

  it('T01-P17-transformer-star-barrel', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-transformer-star-'));
    dirs.push(dir);
    const barrelPath = path.join(dir, 'barrel.ts');
    const consumerPath = path.join(dir, 'consumer.ts');
    const plainPath = path.join(dir, 'plain.ts');
    const depPath = path.join(dir, 'dep.ts');
    writeFileSync(barrelPath, `export * from '@djodjonx/neosyringe';\n`);
    writeFileSync(depPath, `export function x(): number { return 1; }\n`);
    writeFileSync(consumerPath, `
import { defineBuilderConfig as b } from './barrel';

class Service {}

export const c = b({
  injections: [{ token: Service }],
});
`);
    const plainSource = `import { x } from './dep';\nexport const n = x();\nexport const m = Math.max(1, 2);\n`;
    writeFileSync(plainPath, plainSource);

    const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) throw new Error('tsconfig.json introuvable');
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, process.cwd());
    const program = ts.createProgram([consumerPath, plainPath], parsed.options);
    const { default: neoSyringeTransformer } = await import('../src/transformer');
    const next = neoSyringeTransformer(program, undefined, {}, { ts } as never);
    const consumerOut = next.getSourceFile(consumerPath)?.text ?? '';
    const plainOut = next.getSourceFile(plainPath)?.text ?? '';
    expect(consumerOut).not.toContain('export const c = b(');
    expect(consumerOut).toContain('class NeoContainer');
    expect(plainOut).toBe(plainSource);
  });
});
