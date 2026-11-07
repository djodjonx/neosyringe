import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { createVirtualProgram } from './createVirtualProgram';

describe('ts path', () => {
  it('createVirtualProgram finds a Windows-style root name', () => {
    const program = createVirtualProgram('C:\\virtual\\neo\\box.ts', 'export class Box {}\n', {
      noLib: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      strict: true,
    });
    const source = program.getSourceFile('C:/virtual/neo/box.ts');
    expect(source?.text ?? '').toContain('export class Box');
  });
});
