export function assertExactPins(specs: string | readonly string[]): void;
export function assertInstalledVersion(installed: string, pin: string): void;
export function compareBehaviour(before: object, after: object, declared: object): unknown[];
export function assertDiagnostic(output: string, code: string): string;
export function assertBuildOutsideRepo(
  proof: { projectRoot?: string; paths?: readonly string[]; reads?: readonly string[]; ok?: boolean },
  root: string,
): void;
export function assertNoNestedDjodjonx(paths: string | readonly string[]): void;
