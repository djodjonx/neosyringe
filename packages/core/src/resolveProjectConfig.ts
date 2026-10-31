import * as path from 'node:path';
import * as ts from 'typescript';

export interface ResolvedProjectConfig {
  configPath: string;
  root: string;
  options: ts.CompilerOptions;
  fileNames: string[];
  parseErrors: readonly ts.Diagnostic[];
}

/**
 * The only tsconfig resolver. `project` is resolved from `cwd` and is not searched.
 * Without it, `tsconfig.json` is found from `cwd`. The parse base is the tsconfig directory.
 */
export function resolveProjectConfig(cwd: string, project?: string, hint?: string): ResolvedProjectConfig {
  const configPath = project
    ? path.resolve(cwd, project)
    : ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) {
    throw new Error(
      `[NeoSyringe] Could not find tsconfig.json in ${cwd}. ${hint ?? 'Pass project to select a tsconfig.'}`,
    );
  }
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    const tsMessage = ts.flattenDiagnosticMessageText(read.error.messageText, '\n');
    throw new Error(`[NeoSyringe] Could not read ${configPath}: ${tsMessage}`);
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
  return {
    configPath,
    root: path.dirname(configPath),
    options: parsed.options,
    fileNames: parsed.fileNames,
    parseErrors: parsed.errors,
  };
}
