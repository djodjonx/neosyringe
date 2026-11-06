export function declaredEntries(pkg: Record<string, unknown>): string[];
export function extractTarball(tarball: string, destDir: string): string;
export function assertTarballFromBuild(
  tarball: string,
  pkgDir: string,
): { name: string; version: string; distFiles: number };
export function assertDistNewerThanSrc(distFile: string, srcDir: string): void;
