import path from 'node:path';

/** TypeScript stores and queries file names with forward slashes. */
export function tsPath(fileName: string): string {
  return fileName.replace(/\\/g, '/');
}

export function sameFile(left: string, right: string): boolean {
  return tsPath(left) === tsPath(right);
}

export function textAt(files: ReadonlyMap<string, string>, fileName: string): string | undefined {
  const wanted = tsPath(fileName);
  const direct = files.get(fileName) ?? files.get(wanted);
  if (direct !== undefined) return direct;
  for (const [key, text] of files) {
    if (tsPath(key) === wanted) return text;
  }
  return undefined;
}

export function hasText(files: ReadonlyMap<string, string>, fileName: string): boolean {
  return textAt(files, fileName) !== undefined;
}

/** Relative virtual file, using the same slash form TypeScript uses. */
export function virtualResolved(
  files: ReadonlyMap<string, string>,
  containingFile: string,
  moduleName: string,
  extensions: readonly string[] = ['.ts'],
): string | undefined {
  if (!moduleName.startsWith('.')) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(tsPath(containingFile)), moduleName));
  const candidates = [base];
  for (const extension of extensions) {
    if (!base.endsWith(extension)) candidates.push(`${base}${extension}`);
  }
  return candidates.find((candidate) => hasText(files, candidate));
}
