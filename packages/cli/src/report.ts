import { toStableDiagnostic, type AnalysisError, type ContainerLookup, type DiagnosticCode } from '@djodjonx/neosyringe-core/analyzer';
import { relative } from 'node:path';

export interface CliArgs {
  project: string | undefined;
  json: boolean;
  /** Path to write HTML output, true for default filename, false if not requested. */
  graph: string | true | false;
  mermaid: boolean;
  /** Output path for protocol v1. Requires `--contract-version`. */
  tokensManifest: string | undefined;
  /** Explicit token contract. Not the package version. */
  contractVersion: string | undefined;
  /** Token to explain (`--explain <token>`). */
  explain: string | undefined;
  /** Container key or name that narrows `--explain` (`--container <name|key>`). */
  container: string | undefined;
  /** Path to write the retention report, true for stdout, false if not requested. */
  retentionReport: string | true | false;
  help: boolean;
}

/** Usage text printed by `--help`. */
export const CLI_USAGE = `Usage: neosyringe-check [options]

Validates the dependency injection graph of a TypeScript project.

Options:
  -p, --project <path>          tsconfig to analyze (default: ./tsconfig.json)
  --json                        machine-readable output, schemaVersion 1
  --graph [path]                write the HTML dependency graph
  --mermaid                     print the graph as a Mermaid diagram
  --tokens-manifest <path>      write the tokens manifest (needs --contract-version)
  --contract-version <version>  explicit token contract version
  --explain <token>             tell why a token is kept (simple name or full token id)
  --container <name|key>        narrow --explain to one container (containerKey first, then name)
  --retention-report [path]     write the versioned retention report to path, or print it to stdout
  --help                        print this text

--explain exits 0 when the token is found, 1 when it is absent or when --container matches no container
(that result carries containerFound: false). --explain is exclusive: with --retention-report, --graph or
--mermaid it is a usage error (exit 2).
--retention-report <path> writes the file and still validates. --retention-report alone prints only the
report on stdout (banner and errors go to stderr) and cannot be combined with --json or --mermaid.
A flag without its value, or --container without --explain, is a usage error (exit 2).
The retention report gives causes and paths only: no size attribution.
`;

/** True when `value` is a flag value: present and not another flag (`--x` or `-x`). */
function isValue(value: string | undefined): value is string {
  return value !== undefined && !value.startsWith('-');
}

/** Parses CLI arguments. Pure and side-effect free — easy to unit test. */
export function parseArgs(argv: string[]): CliArgs {
  let project: string | undefined;
  let json = false;
  let graph: string | true | false = false;
  let mermaid = false;
  let tokensManifest: string | undefined;
  let contractVersion: string | undefined;
  let explain: string | undefined;
  let container: string | undefined;
  let retentionReport: string | true | false = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--project' || argv[i] === '-p') && argv[i + 1]) {
      project = argv[i + 1];
    }
    if (argv[i] === '--json') {
      json = true;
    }
    if (argv[i] === '--graph') {
      const next = argv[i + 1];
      graph = next && !next.startsWith('--') ? next : true;
    }
    if (argv[i] === '--mermaid') {
      mermaid = true;
    }
    if (argv[i] === '--tokens-manifest' && argv[i + 1]) {
      tokensManifest = argv[i + 1];
    }
    if (argv[i] === '--contract-version' && argv[i + 1]) {
      contractVersion = argv[i + 1];
    }
    if (argv[i] === '--explain' && isValue(argv[i + 1])) {
      explain = argv[i + 1];
    }
    if (argv[i] === '--container' && isValue(argv[i + 1])) {
      container = argv[i + 1];
    }
    if (argv[i] === '--retention-report') {
      const next = argv[i + 1];
      retentionReport = isValue(next) ? next : true;
    }
    if (argv[i] === '--help') {
      help = true;
    }
  }

  if (tokensManifest?.startsWith('--')) tokensManifest = '';
  if (contractVersion?.startsWith('--')) contractVersion = undefined;
  return { project, json, graph, mermaid, tokensManifest, contractVersion, explain, container, retentionReport, help };
}

/**
 * The first misuse of the new flags, or undefined. Pure: the caller prints it and exits 2.
 * `argv` is needed because `parseArgs` drops a flag that has no value.
 */
export function findUsageError(argv: string[], args: CliArgs): string | undefined {
  if (argv.includes('--explain') && args.explain === undefined) {
    return '--explain needs a token (a simple name or a full token id).';
  }
  if (argv.includes('--container') && args.container === undefined) {
    return '--container needs a container name or key.';
  }
  if (args.container !== undefined && args.explain === undefined) {
    return '--container only narrows --explain; it has no effect alone.';
  }
  if (args.explain !== undefined && (args.retentionReport !== false || args.graph !== false || args.mermaid)) {
    return '--explain cannot be combined with --retention-report, --graph or --mermaid.';
  }
  if (args.retentionReport === true && (args.json || args.mermaid)) {
    return '--retention-report without a path prints the report to stdout; give it a path to combine it with --json or --mermaid.';
  }
  return undefined;
}

/** Version of the `--json` report. Bump on a breaking change of its shape. */
export const REPORT_SCHEMA_VERSION = 1;

export interface JsonReportError {
  /** Stable machine contract. Absent only for errors that have no code yet. */
  code?: DiagnosticCode;
  severity: 'error' | 'warning';
  file: string;
  line: number;
  column: number;
  type: string;
  message: string;
  containerId?: string;
  /** Name of that container, when known. */
  containerName?: string;
  /** Source file of that container, relative to the working directory, when known. */
  containerFile?: string;
  token?: string;
  chain?: string[];
}

export interface JsonReport {
  schemaVersion: 1;
  ok: boolean;
  errorCount: number;
  errors: JsonReportError[];
}

/** Report for a failure that stops the run before any validation. */
export function buildFatalReport(message: string): JsonReport & { fatal: string } {
  return { schemaVersion: REPORT_SCHEMA_VERSION, ok: false, errorCount: 0, errors: [], fatal: message };
}

/**
 * Builds a machine-readable report for `--json` mode, suitable for CI
 * integration (e.g. `neosyringe-check --json | jq '.errors'`).
 * Code and severity come from the shared stable diagnostic, never from the message.
 */
export function buildJsonReport(errors: AnalysisError[], cwd: string, lookup?: ContainerLookup): JsonReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    ok: errors.length === 0,
    errorCount: errors.length,
    errors: errors.map(err => {
      const diagnostic = toStableDiagnostic(err, lookup);
      return {
        ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
        severity: diagnostic.severity,
        file: relative(cwd, diagnostic.file),
        line: diagnostic.line,
        column: diagnostic.column,
        type: diagnostic.type,
        message: diagnostic.message,
        ...(diagnostic.containerId !== undefined ? { containerId: diagnostic.containerId } : {}),
        ...(diagnostic.containerName !== undefined ? { containerName: diagnostic.containerName } : {}),
        ...(diagnostic.containerFile !== undefined ? { containerFile: relative(cwd, diagnostic.containerFile) } : {}),
        ...(diagnostic.token !== undefined ? { token: diagnostic.token } : {}),
        ...(diagnostic.chain !== undefined ? { chain: diagnostic.chain } : {}),
      };
    }),
  };
}
