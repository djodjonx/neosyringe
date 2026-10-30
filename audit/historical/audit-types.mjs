import ts from 'typescript';
const name = `${process.cwd()}/audit-consumer.ts`;
const source = `
import { defineBuilderConfig, useInterface } from './packages/neosyringe/src/types';
interface ILogger { name: string }
const c = defineBuilderConfig({ injections: [{ token: useInterface<ILogger>(), provider: async () => ({ name: 'real' }), useFactory: true }] });
c.initialize();
c.override(useInterface<ILogger>(), () => ({ name: 'mock' }));
c.clearOverrides();
c.on('resolve', () => {});
`;
const options = { strict: true, noEmit: true, skipLibCheck: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2020 };
const host = ts.createCompilerHost(options);
const original = host.getSourceFile;
host.getSourceFile = (f, v, ...rest) => f === name ? ts.createSourceFile(f, source, v, true) : original(f, v, ...rest);
const program = ts.createProgram([name], options, host);
for (const d of ts.getPreEmitDiagnostics(program).filter(d => d.file?.fileName === name)) {
  console.log(`${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
}
