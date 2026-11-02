# @djodjonx/neosyringe-cli

CLI validator for NeoSyringe dependency graphs.

## Usage

```bash
npx neosyringe-check
```

See [Documentation](https://djodjonx.github.io/neosyringe/guide/cli).

## Options

- `--project <path>` (`-p`): tsconfig to analyze.
- `--json`: machine-readable output.
- `--graph [path]`: write the HTML dependency graph.
- `--mermaid`: print the graph as a Mermaid diagram.
- `--tokens-manifest <path>`: write the tokens manifest (needs `--contract-version`).
- `--contract-version <version>`: explicit token contract version.
- `--explain <token>`: tell why a token is kept.
- `--container <name|key>`: narrow `--explain` to one container.
- `--retention-report [path]`: write the retention report to `path`, or print it to stdout.
- `--help`: print the usage.

## Diagnostics in JSON

`--json` prints `schemaVersion: 1`. Each error carries a stable `code` (for example `NEO_MISSING_PROVIDER`)
and a `severity` (`error` or `warning`). The `message` is for humans and may be reworded: match on `code`.
`token`, `chain` and `containerId` are present when the analyzer knows them. When `containerId` is set,
`containerName` and `containerFile` (relative to the working directory) name that container and its source file,
for example for a constructor dependency that no registration of the container provides.
The LSP and the devtools graph (`serializeGraph`) report the same `code` and `severity`.

## Explain why a token is kept

```bash
npx neosyringe-check --explain UserRepository
npx neosyringe-check --explain UserRepository --container AppContainer --json
```

`<token>` is the simple name, else the full token id. `--container` takes a `containerKey`, else a container name.
Two containers can share a name, so the answer has one result per matching container.
The command exits 0 when the token is found and 1 when it is absent.
An absent token names the container that was asked and its source file.
A `--container` that matches no container is a different answer: the result is
`{ "found": false, "token": "...", "containerFound": false, "container": "<the filter>" }` and the text says so. It also exits 1.
When one container has several registrations for the same token (a multi token), the text mode prints the `registrationId` of each.

`--explain --json` prints:

```json
{
  "schemaVersion": 1,
  "results": [
    {
      "found": true,
      "token": "UserRepository",
      "containerKey": "c_1a2b3c4d",
      "containerName": "AppContainer",
      "sourceFile": "src/container.ts",
      "registrationId": "src/container.ts:312",
      "cause": "dependency-of",
      "path": ["UserController", "UserService", "UserRepository"]
    }
  ]
}
```

`path` starts at the root and follows the recorded reason of each registration.

## Retention report

```bash
npx neosyringe-check --retention-report retention.json
npx neosyringe-check --retention-report > retention.json
```

With no path, `stdout` holds the report only: the `Analyzing project` line and the validation messages go to `stderr`,
so the redirect gives a valid JSON file. With a path, the report is written to the file and the normal run goes on.

### Flag combinations and exit codes

| Command | Behavior |
|---|---|
| `--retention-report <path>` (with or without `--json`) | writes the file, then validates as usual: `--json` still prints the validation report on stdout and the run exits 1 on errors |
| `--retention-report` (no path) | prints the report on stdout, validation messages on stderr, exit 1 when validation fails, else 0 |
| `--retention-report` (no path) with `--json` or `--mermaid` | usage error (exit 2): two documents cannot share stdout; give a path |
| `--explain` with `--retention-report`, `--graph` or `--mermaid` | usage error (exit 2) |
| `--explain` without a token, `--container` without a value, `--container` without `--explain` | usage error (exit 2) |

| Exit | Meaning |
|---|---|
| 0 | success (`--explain`: token found) |
| 1 | validation errors, a fatal error, or `--explain` with an absent token or an unknown `--container` |
| 2 | usage error |

In `--json` mode a usage error prints a fatal report (`schemaVersion: 1`, `fatal` holds the message) on stdout.
A value that starts with `-` is never taken as a flag value: `--retention-report -p tsconfig.json` prints to stdout and uses `tsconfig.json` as the project.

```json
{
  "schemaVersion": 1,
  "containers": [
    {
      "containerKey": "c_1a2b3c4d",
      "containerName": "AppContainer",
      "sourceFile": "src/container.ts",
      "entries": [
        { "registrationId": "src/container.ts:312", "token": "UserRepository", "cause": "dependency-of", "path": ["UserController", "UserService", "UserRepository"] }
      ]
    }
  ]
}
```

Containers are identified by `containerKey`, never by name.
Service values, secrets and runtime objects are never written.

### Causes

| `cause` | Meaning |
|---|---|
| `root` | exported root of a closed container |
| `eager` | eager root, constructed once from `initialize` |
| `dependency-of` | required by the registration named before it in `path` |
| `multi-contribution-of` | contribution to a multi token that the registration before it in `path` requests with `{ all: token }` |
| `open-parent` | open or absent optimization mode: the container is a conservative boundary, everything stays |
| `opaque-boundary` | compatible-mode factory without a `dependencies` list: its subgraph cannot be shaken |
| `unreachable` | no root reaches it in a closed container (`path` is empty) |

The report states why a registration is kept. There is no size field: the report gives no size attribution
and invents no removable weight.
