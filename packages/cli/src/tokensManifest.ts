import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { resolveProjectConfig } from '@djodjonx/neosyringe-core/analyzer';
import { writeTokensManifest } from '@djodjonx/neosyringe-core/generator';

export interface TokensManifestRequest {
  tokensManifest: string | undefined;
  contractVersion?: string | undefined;
  project?: string | undefined;
  cwd: string;
  /** Reuse the caller's program. Absent means a program is created here. */
  program?: ts.Program;
}

function packageRootOf(start: string): string {
  let dir = start;
  while (true) {
    if (ts.sys.fileExists(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/**
 * `--tokens-manifest` writes protocol v1.
 * `--contract-version` is required and is not the package version.
 */
export function emitTokensManifest(request: TokensManifestRequest): string {
  if (request.tokensManifest === undefined || request.tokensManifest === '' || request.tokensManifest.startsWith('--')) {
    throw new Error('--tokens-manifest <file> is required');
  }
  if (!request.contractVersion) {
    throw new Error('NEO_TOKEN_BOUNDARY_UNSUPPORTED: contract-version');
  }
  const resolved = resolveProjectConfig(request.cwd, request.project, 'Use --project <path>.');
  if (resolved.parseErrors.length > 0) {
    const messages = resolved.parseErrors.map((error) =>
      ts.flattenDiagnosticMessageText(error.messageText, '\n'));
    throw new Error(messages.join('\n'));
  }
  const program = request.program ?? ts.createProgram(resolved.fileNames, resolved.options);
  const manifest = writeTokensManifest({
    program,
    packageRoot: packageRootOf(resolved.root),
    projectRoot: resolved.root,
    contractVersion: request.contractVersion,
  });
  const outFile = path.resolve(request.cwd, request.tokensManifest);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return outFile;
}
