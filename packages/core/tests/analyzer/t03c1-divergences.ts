/**
 * Intended divergences between the base analyzer (da6641b) and the snapshot analyzer.
 * The golden JSON is captured once from base and never edited. P5 compares golden + this list only:
 * an unlisted difference fails. Each entry is also asserted by its own named test.
 *
 * `path` walks the dump of one fixture (see tests/helpers/t03c1-dump.ts). `old` must equal the golden
 * value at that path, `next` is what the snapshot analyzer returns.
 */
export interface Divergence {
  readonly id: string;
  readonly fixture: string;
  readonly path: readonly (string | number)[];
  readonly old: unknown;
  readonly next: unknown;
  readonly reason: string;
  /** Spec line (folder /Users/jonathan/Downloads/neosyringe) that requires the change. */
  readonly spec: string;
}

export const DIVERGENCES: readonly Divergence[] = [
  {
    id: "D2-extends-through-alias#aliased-imports#0",
    fixture: "aliased-imports",
    path: ["extractAllErrors"],
    old: [
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Logger' required by 'App' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/aliased-imports/app.ts",
        "start": 365,
        "end": 375,
        "tokenText": "Logger_d30671c7",
        "chain": [
          "App",
          "Logger"
        ],
        "containerId": null
      },
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Logger' required by 'Child' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/aliased-imports/app.ts",
        "start": 543,
        "end": 555,
        "tokenText": "Logger_d30671c7",
        "chain": [
          "Child",
          "Logger"
        ],
        "containerId": null
      }
    ],
    next: [],
    reason: "a partial listed in extends under an alias or a re-export name is found by identity, so the false NEO_MISSING_PROVIDER of the token it provides disappears",
    spec: "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and DECISIONS.md \"Analyse et cache\" (\"Ne pas fusionner des configurations par leur seul nom de variable\")",
  },
  {
    id: "D2-extends-through-alias#aliased-imports#1",
    fixture: "aliased-imports",
    path: ["extractForFile", "/virtual/t09-capture/aliased-imports/app.ts"],
    old: [
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Logger' required by 'App' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/aliased-imports/app.ts",
        "start": 365,
        "end": 375,
        "tokenText": "Logger_d30671c7",
        "chain": [
          "App",
          "Logger"
        ],
        "containerId": null
      },
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Logger' required by 'Child' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/aliased-imports/app.ts",
        "start": 543,
        "end": 555,
        "tokenText": "Logger_d30671c7",
        "chain": [
          "Child",
          "Logger"
        ],
        "containerId": null
      }
    ],
    next: [],
    reason: "a partial listed in extends under an alias or a re-export name is found by identity, so the false NEO_MISSING_PROVIDER of the token it provides disappears",
    spec: "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and DECISIONS.md \"Analyse et cache\" (\"Ne pas fusionner des configurations par leur seul nom de variable\")",
  },
  {
    id: "D2-extract-skips-parent-by-identity#aliased-imports#2",
    fixture: "aliased-imports",
    path: ["extract", "retention", 0],
    old: "aliased-imports/parts.ts:358|parent-boundary",
    next: "aliased-imports/parts.ts:236|parent-boundary",
    reason: "extract() skips a builder used as a parent by configuration identity: `useContainer: ParentAlias` names `parentBox`, so parentBox is no longer folded into the merged graph",
    spec: "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and DECISIONS.md \"Analyse et cache\" (\"Ne pas fusionner des configurations par leur seul nom de variable\")",
  },
  {
    id: "D2-extract-skips-parent-by-identity#aliased-imports#3",
    fixture: "aliased-imports",
    path: ["extract", "nodes", 0, "registration"],
    old: "/virtual/t09-capture/aliased-imports/parts.ts:358",
    next: "/virtual/t09-capture/aliased-imports/parts.ts:236",
    reason: "extract() skips a builder used as a parent by configuration identity: `useContainer: ParentAlias` names `parentBox`, so parentBox is no longer folded into the merged graph",
    spec: "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and DECISIONS.md \"Analyse et cache\" (\"Ne pas fusionner des configurations par leur seul nom de variable\")",
  },
  {
    id: "D2-extract-skips-parent-by-identity#aliased-imports#4",
    fixture: "aliased-imports",
    path: ["extract", "nodes", 0, "registrationId"],
    old: "aliased-imports/parts.ts:358",
    next: "aliased-imports/parts.ts:236",
    reason: "extract() skips a builder used as a parent by configuration identity: `useContainer: ParentAlias` names `parentBox`, so parentBox is no longer folded into the merged graph",
    spec: "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and DECISIONS.md \"Analyse et cache\" (\"Ne pas fusionner des configurations par leur seul nom de variable\")",
  },
  {
    id: "D2-extract-skips-parent-by-identity#aliased-imports#5",
    fixture: "aliased-imports",
    path: ["extract", "errors"],
    old: [
      {
        "type": "duplicate",
        "code": null,
        "severity": null,
        "message": "Duplicate registration: 'Logger' is already registered.",
        "file": "/virtual/t09-capture/aliased-imports/parts.ts",
        "start": 236,
        "end": 253,
        "tokenText": null,
        "chain": null,
        "containerId": null
      }
    ],
    next: [],
    reason: "extract() skips a builder used as a parent by configuration identity: `useContainer: ParentAlias` names `parentBox`, so parentBox is no longer folded into the merged graph",
    spec: "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and DECISIONS.md \"Analyse et cache\" (\"Ne pas fusionner des configurations par leur seul nom de variable\")",
  },
  {
    id: "D2-extends-through-alias#reexport#6",
    fixture: "reexport",
    path: ["extractAllErrors"],
    old: [
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Store' required by 'Svc' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/reexport/app.ts",
        "start": 336,
        "end": 346,
        "tokenText": "Store_6da9b05a",
        "chain": [
          "Svc",
          "Store"
        ],
        "containerId": null
      }
    ],
    next: [],
    reason: "a partial listed in extends under an alias or a re-export name is found by identity, so the false NEO_MISSING_PROVIDER of the token it provides disappears",
    spec: "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and DECISIONS.md \"Analyse et cache\" (\"Ne pas fusionner des configurations par leur seul nom de variable\")",
  },
  {
    id: "D2-extends-through-alias#reexport#7",
    fixture: "reexport",
    path: ["extractForFile", "/virtual/t09-capture/reexport/app.ts"],
    old: [
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Store' required by 'Svc' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/reexport/app.ts",
        "start": 336,
        "end": 346,
        "tokenText": "Store_6da9b05a",
        "chain": [
          "Svc",
          "Store"
        ],
        "containerId": null
      }
    ],
    next: [],
    reason: "a partial listed in extends under an alias or a re-export name is found by identity, so the false NEO_MISSING_PROVIDER of the token it provides disappears",
    spec: "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and DECISIONS.md \"Analyse et cache\" (\"Ne pas fusionner des configurations par leur seul nom de variable\")",
  },
  {
    id: "D2-parent-through-alias#parent-declare-tokens#8",
    fixture: "parent-declare-tokens",
    path: ["extractAllErrors"],
    old: [
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Old' required by 'Fresh' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/parent-declare-tokens/aliased.ts",
        "start": 337,
        "end": 349,
        "tokenText": "Old_4c0e1230",
        "chain": [
          "Fresh",
          "Old"
        ],
        "containerId": null
      }
    ],
    next: [],
    reason: "a declareContainerTokens parent imported under another name is found through its alias, so the false NEO_MISSING_PROVIDER disappears",
    spec: "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and DECISIONS.md \"Analyse et cache\" (\"Ne pas fusionner des configurations par leur seul nom de variable\")",
  },
  {
    id: "D2-parent-through-alias#parent-declare-tokens#9",
    fixture: "parent-declare-tokens",
    path: ["extractForFile", "/virtual/t09-capture/parent-declare-tokens/aliased.ts"],
    old: [
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Old' required by 'Fresh' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/parent-declare-tokens/aliased.ts",
        "start": 337,
        "end": 349,
        "tokenText": "Old_4c0e1230",
        "chain": [
          "Fresh",
          "Old"
        ],
        "containerId": null
      }
    ],
    next: [],
    reason: "a declareContainerTokens parent imported under another name is found through its alias, so the false NEO_MISSING_PROVIDER disappears",
    spec: "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and DECISIONS.md \"Analyse et cache\" (\"Ne pas fusionner des configurations par leur seul nom de variable\")",
  },
  {
    id: "D1-config-less-file#resolve-usages#10",
    fixture: "resolve-usages",
    path: ["extractAllErrors"],
    old: [],
    next: [
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": "error",
        "message": "NEO_MISSING_PROVIDER: 'Unknown' is not in container 'Container_581e5cc0'",
        "file": "/virtual/t09-capture/resolve-usages/caller.ts",
        "start": 124,
        "end": 150,
        "tokenText": "Unknown_651b0efa",
        "chain": null,
        "containerId": "Container_581e5cc0"
      }
    ],
    reason: "extractAllErrors also lists the resolve errors of a file that holds no container (the IDE and the build already did)",
    spec: "topics/03.md steps 2 and 5 (validateResolutionUsages once per file for every file of the snapshot; extractAllErrors returns the snapshot diagnostics) and 03-analyse-commune.md \"Acceptation\" (same diagnostics in CLI, IDE and build)",
  },
  {
    "id": "D4-parent-multi-all#parent-multi-all#0",
    "fixture": "parent-multi-all",
    "path": [
      "extractAllErrors"
    ],
    "old": [
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Plugin' required by 'summary' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/parent-multi-all/open.ts",
        "start": 691,
        "end": 705,
        "tokenText": "Plugin_0072e8be",
        "chain": [
          "Summary",
          "Plugin"
        ],
        "containerId": null
      },
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Plugin' required by 'summary' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/parent-multi-all/closed.ts",
        "start": 837,
        "end": 851,
        "tokenText": "Plugin_61cc6f91",
        "chain": [
          "Summary",
          "Plugin"
        ],
        "containerId": null
      },
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Secret' required by 'summary' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/parent-multi-all/closed.ts",
        "start": 1117,
        "end": 1131,
        "tokenText": "Secret_c0643286",
        "chain": [
          "Summary",
          "Secret"
        ],
        "containerId": null
      },
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Plugin' required by 'summary' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/parent-multi-all/partial.ts",
        "start": 550,
        "end": 564,
        "tokenText": "Plugin_a89daa37",
        "chain": [
          "Summary",
          "Plugin"
        ],
        "containerId": null
      }
    ],
    "next": [
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Secret' required by 'summary' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/parent-multi-all/closed.ts",
        "start": 1117,
        "end": 1131,
        "tokenText": "Secret_c0643286",
        "chain": [
          "Summary",
          "Secret"
        ],
        "containerId": null
      }
    ],
    "reason": "a multi token registered by a parent or an extended partial is provided to a child that reads it with `{ all }`, so the false NEO_MISSING_PROVIDER of the IDE disappears (a private multi token of a closed parent stays refused)",
    "spec": "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and 03-analyse-commune.md \"Acceptation\" (same diagnostics in the CLI, the IDE and the build; the build accepted it on base, packages/core/src/generator/GraphValidator.ts:76)"
  },
  {
    "id": "D4-parent-multi-all#parent-multi-all#1",
    "fixture": "parent-multi-all",
    "path": [
      "extractForFile",
      "/virtual/t09-capture/parent-multi-all/closed.ts"
    ],
    "old": [
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Plugin' required by 'summary' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/parent-multi-all/closed.ts",
        "start": 837,
        "end": 851,
        "tokenText": "Plugin_61cc6f91",
        "chain": [
          "Summary",
          "Plugin"
        ],
        "containerId": null
      },
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Secret' required by 'summary' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/parent-multi-all/closed.ts",
        "start": 1117,
        "end": 1131,
        "tokenText": "Secret_c0643286",
        "chain": [
          "Summary",
          "Secret"
        ],
        "containerId": null
      }
    ],
    "next": [
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Secret' required by 'summary' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/parent-multi-all/closed.ts",
        "start": 1117,
        "end": 1131,
        "tokenText": "Secret_c0643286",
        "chain": [
          "Summary",
          "Secret"
        ],
        "containerId": null
      }
    ],
    "reason": "a multi token registered by a parent or an extended partial is provided to a child that reads it with `{ all }`, so the false NEO_MISSING_PROVIDER of the IDE disappears (a private multi token of a closed parent stays refused)",
    "spec": "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and 03-analyse-commune.md \"Acceptation\" (same diagnostics in the CLI, the IDE and the build; the build accepted it on base, packages/core/src/generator/GraphValidator.ts:76)"
  },
  {
    "id": "D4-parent-multi-all#parent-multi-all#2",
    "fixture": "parent-multi-all",
    "path": [
      "extractForFile",
      "/virtual/t09-capture/parent-multi-all/open.ts"
    ],
    "old": [
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Plugin' required by 'summary' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/parent-multi-all/open.ts",
        "start": 691,
        "end": 705,
        "tokenText": "Plugin_0072e8be",
        "chain": [
          "Summary",
          "Plugin"
        ],
        "containerId": null
      }
    ],
    "next": [],
    "reason": "a multi token registered by a parent or an extended partial is provided to a child that reads it with `{ all }`, so the false NEO_MISSING_PROVIDER of the IDE disappears (a private multi token of a closed parent stays refused)",
    "spec": "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and 03-analyse-commune.md \"Acceptation\" (same diagnostics in the CLI, the IDE and the build; the build accepted it on base, packages/core/src/generator/GraphValidator.ts:76)"
  },
  {
    "id": "D4-parent-multi-all#parent-multi-all#3",
    "fixture": "parent-multi-all",
    "path": [
      "extractForFile",
      "/virtual/t09-capture/parent-multi-all/partial.ts"
    ],
    "old": [
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Plugin' required by 'summary' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/parent-multi-all/partial.ts",
        "start": 550,
        "end": 564,
        "tokenText": "Plugin_a89daa37",
        "chain": [
          "Summary",
          "Plugin"
        ],
        "containerId": null
      }
    ],
    "next": [],
    "reason": "a multi token registered by a parent or an extended partial is provided to a child that reads it with `{ all }`, so the false NEO_MISSING_PROVIDER of the IDE disappears (a private multi token of a closed parent stays refused)",
    "spec": "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and 03-analyse-commune.md \"Acceptation\" (same diagnostics in the CLI, the IDE and the build; the build accepted it on base, packages/core/src/generator/GraphValidator.ts:76)"
  },
  {
    "id": "D5-closed-parent-offers-exports#closed-parent-private#0",
    "fixture": "closed-parent-private",
    "path": [
      "extractAllErrors"
    ],
    "old": [
      {
        "type": "duplicate",
        "code": "NEO_DUPLICATE_PROVIDER",
        "severity": null,
        "message": "Duplicate registration: 'Secret' is already registered in parent container 'parent'.",
        "file": "/virtual/t09-capture/closed-parent-private/closed.ts",
        "start": 856,
        "end": 869,
        "tokenText": "Secret",
        "chain": null,
        "containerId": null
      }
    ],
    "next": [
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Secret' required by 'NeedsSecret' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/closed-parent-private/closed.ts",
        "start": 721,
        "end": 739,
        "tokenText": "Secret_90f745e3",
        "chain": [
          "NeedsSecret",
          "Secret"
        ],
        "containerId": null
      }
    ],
    "reason": "a closed parent offers its exported roots only: a private token it keeps is missing in the child that reads it (the build refused it already: ParentContainerResolver.ts:156 copyClosedParent) and is not a duplicate when the child registers it (packages/core/src/generator/GraphValidator.ts:52 reads what the parent provides)",
    "spec": "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and 03-analyse-commune.md \"Acceptation\" (same diagnostics in the CLI, the IDE and the build)"
  },
  {
    "id": "D5-closed-parent-offers-exports#closed-parent-private#1",
    "fixture": "closed-parent-private",
    "path": [
      "extractForFile",
      "/virtual/t09-capture/closed-parent-private/closed.ts"
    ],
    "old": [
      {
        "type": "duplicate",
        "code": "NEO_DUPLICATE_PROVIDER",
        "severity": null,
        "message": "Duplicate registration: 'Secret' is already registered in parent container 'parent'.",
        "file": "/virtual/t09-capture/closed-parent-private/closed.ts",
        "start": 856,
        "end": 869,
        "tokenText": "Secret",
        "chain": null,
        "containerId": null
      }
    ],
    "next": [
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "Missing injection: 'Secret' required by 'NeedsSecret' is not registered in this builder nor its parents/extends",
        "file": "/virtual/t09-capture/closed-parent-private/closed.ts",
        "start": 721,
        "end": 739,
        "tokenText": "Secret_90f745e3",
        "chain": [
          "NeedsSecret",
          "Secret"
        ],
        "containerId": null
      }
    ],
    "reason": "a closed parent offers its exported roots only: a private token it keeps is missing in the child that reads it (the build refused it already: ParentContainerResolver.ts:156 copyClosedParent) and is not a duplicate when the child registers it (packages/core/src/generator/GraphValidator.ts:52 reads what the parent provides)",
    "spec": "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and 03-analyse-commune.md \"Acceptation\" (same diagnostics in the CLI, the IDE and the build)"
  },
  {
    "id": "D6-expects-through-alias#expects-alias#0",
    "fixture": "expects-alias",
    "path": [
      "extractAllErrors"
    ],
    "old": [
      {
        "type": "missing",
        "code": null,
        "severity": null,
        "message": "Missing token: 'Needed' is declared in 'basePart.expects' but is not provided by this builder or its parent container.",
        "file": "/virtual/t09-capture/expects-alias/app.ts",
        "start": 495,
        "end": 579,
        "tokenText": "Needed_2677a9e2",
        "chain": null,
        "containerId": null
      }
    ],
    "next": [
      {
        "type": "missing",
        "code": null,
        "severity": null,
        "message": "Missing token: 'Needed' is declared in 'shared.expects' but is not provided by this builder or its parent container.",
        "file": "/virtual/t09-capture/expects-alias/app.ts",
        "start": 278,
        "end": 354,
        "tokenText": "Needed_2677a9e2",
        "chain": null,
        "containerId": null
      },
      {
        "type": "missing",
        "code": null,
        "severity": null,
        "message": "Missing token: 'Needed' is declared in 'sharedOut.expects' but is not provided by this builder or its parent container.",
        "file": "/virtual/t09-capture/expects-alias/app.ts",
        "start": 383,
        "end": 465,
        "tokenText": "Needed_2677a9e2",
        "chain": null,
        "containerId": null
      },
      {
        "type": "missing",
        "code": null,
        "severity": null,
        "message": "Missing token: 'Needed' is declared in 'B.basePart.expects' but is not provided by this builder or its parent container.",
        "file": "/virtual/t09-capture/expects-alias/app.ts",
        "start": 495,
        "end": 579,
        "tokenText": "Needed_2677a9e2",
        "chain": null,
        "containerId": null
      }
    ],
    "reason": "expects is checked for a partial extended under an alias, a re-export name or a namespace, and named as the user wrote it in extends (shared, sharedOut, B.basePart); on base the lookup by written name found nothing for the first two and named the namespace one by its declaration (basePart)",
    "spec": "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and 03-analyse-commune.md \"Acceptation\" (same diagnostics in the CLI, the IDE and the build)"
  },
  {
    "id": "D6-expects-through-alias#expects-alias#1",
    "fixture": "expects-alias",
    "path": [
      "extractForFile",
      "/virtual/t09-capture/expects-alias/app.ts"
    ],
    "old": [
      {
        "type": "missing",
        "code": null,
        "severity": null,
        "message": "Missing token: 'Needed' is declared in 'basePart.expects' but is not provided by this builder or its parent container.",
        "file": "/virtual/t09-capture/expects-alias/app.ts",
        "start": 495,
        "end": 579,
        "tokenText": "Needed_2677a9e2",
        "chain": null,
        "containerId": null
      }
    ],
    "next": [
      {
        "type": "missing",
        "code": null,
        "severity": null,
        "message": "Missing token: 'Needed' is declared in 'shared.expects' but is not provided by this builder or its parent container.",
        "file": "/virtual/t09-capture/expects-alias/app.ts",
        "start": 278,
        "end": 354,
        "tokenText": "Needed_2677a9e2",
        "chain": null,
        "containerId": null
      },
      {
        "type": "missing",
        "code": null,
        "severity": null,
        "message": "Missing token: 'Needed' is declared in 'sharedOut.expects' but is not provided by this builder or its parent container.",
        "file": "/virtual/t09-capture/expects-alias/app.ts",
        "start": 383,
        "end": 465,
        "tokenText": "Needed_2677a9e2",
        "chain": null,
        "containerId": null
      },
      {
        "type": "missing",
        "code": null,
        "severity": null,
        "message": "Missing token: 'Needed' is declared in 'B.basePart.expects' but is not provided by this builder or its parent container.",
        "file": "/virtual/t09-capture/expects-alias/app.ts",
        "start": 495,
        "end": 579,
        "tokenText": "Needed_2677a9e2",
        "chain": null,
        "containerId": null
      }
    ],
    "reason": "expects is checked for a partial extended under an alias, a re-export name or a namespace, and named as the user wrote it in extends (shared, sharedOut, B.basePart); on base the lookup by written name found nothing for the first two and named the namespace one by its declaration (basePart)",
    "spec": "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and 03-analyse-commune.md \"Acceptation\" (same diagnostics in the CLI, the IDE and the build)"
  },
  {
    "id": "D7-closed-opaque-through-extends#closed-extends-opaque#0",
    "fixture": "closed-extends-opaque",
    "path": [
      "extractAllErrors"
    ],
    "old": [
      {
        "type": "unsupported",
        "code": "NEO_FACTORY_DEPENDENCIES_REQUIRED",
        "severity": "warning",
        "message": "NEO_FACTORY_DEPENDENCIES_REQUIRED: factory 'port2' has no dependencies list and is opaque.",
        "file": "/virtual/t09-capture/closed-extends-opaque/closed.ts",
        "start": 254,
        "end": 298,
        "tokenText": null,
        "chain": null,
        "containerId": null
      },
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "NEO_MISSING_PROVIDER: root 'Port2' is not registered.",
        "file": "/virtual/t09-capture/closed-extends-opaque/closed.ts",
        "start": 429,
        "end": 434,
        "tokenText": null,
        "chain": null,
        "containerId": null
      },
      {
        "type": "unsupported",
        "code": "NEO_CLOSED_REQUIRES_STRICT",
        "severity": "error",
        "message": "NEO_CLOSED_REQUIRES_STRICT: closed mode requires validation: 'strict'.",
        "file": "/virtual/t09-capture/closed-extends-opaque/closed.ts",
        "start": 350,
        "end": 455,
        "tokenText": null,
        "chain": null,
        "containerId": null
      }
    ],
    "next": [
      {
        "type": "unsupported",
        "code": "NEO_FACTORY_DEPENDENCIES_REQUIRED",
        "severity": "warning",
        "message": "NEO_FACTORY_DEPENDENCIES_REQUIRED: factory 'port2' has no dependencies list and is opaque.",
        "file": "/virtual/t09-capture/closed-extends-opaque/closed.ts",
        "start": 254,
        "end": 298,
        "tokenText": null,
        "chain": null,
        "containerId": null
      },
      {
        "type": "unsupported",
        "code": "NEO_CLOSED_REQUIRES_STRICT",
        "severity": "error",
        "message": "NEO_CLOSED_REQUIRES_STRICT: closed mode requires validation: 'strict'.",
        "file": "/virtual/t09-capture/closed-extends-opaque/closed.ts",
        "start": 350,
        "end": 455,
        "tokenText": null,
        "chain": null,
        "containerId": null
      },
      {
        "type": "unsupported",
        "code": "NEO_FACTORY_DEPENDENCIES_REQUIRED",
        "severity": "error",
        "message": "NEO_FACTORY_DEPENDENCIES_REQUIRED: factory 'Port2_543b9f61' is opaque; closed mode requires a dependencies list.",
        "file": "/virtual/t09-capture/closed-extends-opaque/closed.ts",
        "start": 350,
        "end": 455,
        "tokenText": null,
        "chain": null,
        "containerId": null
      }
    ],
    "reason": "a closed builder counts the opaque factories of the partials folded into it, as the built graph does (packages/core/src/analyzer/graphAdapter.ts:316 opaqueFactoryNames), and a root registered by an extended partial is known, so the false root-not-registered of the IDE disappears",
    "spec": "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and 03-analyse-commune.md \"Acceptation\" (same diagnostics in the CLI, the IDE and the build)"
  },
  {
    "id": "D7-closed-opaque-through-extends#closed-extends-opaque#1",
    "fixture": "closed-extends-opaque",
    "path": [
      "extractForFile",
      "/virtual/t09-capture/closed-extends-opaque/closed.ts"
    ],
    "old": [
      {
        "type": "unsupported",
        "code": "NEO_FACTORY_DEPENDENCIES_REQUIRED",
        "severity": "warning",
        "message": "NEO_FACTORY_DEPENDENCIES_REQUIRED: factory 'port2' has no dependencies list and is opaque.",
        "file": "/virtual/t09-capture/closed-extends-opaque/closed.ts",
        "start": 254,
        "end": 298,
        "tokenText": null,
        "chain": null,
        "containerId": null
      },
      {
        "type": "missing",
        "code": "NEO_MISSING_PROVIDER",
        "severity": null,
        "message": "NEO_MISSING_PROVIDER: root 'Port2' is not registered.",
        "file": "/virtual/t09-capture/closed-extends-opaque/closed.ts",
        "start": 429,
        "end": 434,
        "tokenText": null,
        "chain": null,
        "containerId": null
      },
      {
        "type": "unsupported",
        "code": "NEO_CLOSED_REQUIRES_STRICT",
        "severity": "error",
        "message": "NEO_CLOSED_REQUIRES_STRICT: closed mode requires validation: 'strict'.",
        "file": "/virtual/t09-capture/closed-extends-opaque/closed.ts",
        "start": 350,
        "end": 455,
        "tokenText": null,
        "chain": null,
        "containerId": null
      }
    ],
    "next": [
      {
        "type": "unsupported",
        "code": "NEO_FACTORY_DEPENDENCIES_REQUIRED",
        "severity": "warning",
        "message": "NEO_FACTORY_DEPENDENCIES_REQUIRED: factory 'port2' has no dependencies list and is opaque.",
        "file": "/virtual/t09-capture/closed-extends-opaque/closed.ts",
        "start": 254,
        "end": 298,
        "tokenText": null,
        "chain": null,
        "containerId": null
      },
      {
        "type": "unsupported",
        "code": "NEO_CLOSED_REQUIRES_STRICT",
        "severity": "error",
        "message": "NEO_CLOSED_REQUIRES_STRICT: closed mode requires validation: 'strict'.",
        "file": "/virtual/t09-capture/closed-extends-opaque/closed.ts",
        "start": 350,
        "end": 455,
        "tokenText": null,
        "chain": null,
        "containerId": null
      },
      {
        "type": "unsupported",
        "code": "NEO_FACTORY_DEPENDENCIES_REQUIRED",
        "severity": "error",
        "message": "NEO_FACTORY_DEPENDENCIES_REQUIRED: factory 'Port2_543b9f61' is opaque; closed mode requires a dependencies list.",
        "file": "/virtual/t09-capture/closed-extends-opaque/closed.ts",
        "start": 350,
        "end": 455,
        "tokenText": null,
        "chain": null,
        "containerId": null
      }
    ],
    "reason": "a closed builder counts the opaque factories of the partials folded into it, as the built graph does (packages/core/src/analyzer/graphAdapter.ts:316 opaqueFactoryNames), and a root registered by an extended partial is known, so the false root-not-registered of the IDE disappears",
    "spec": "topics/03.md step 4 (\"R\u00e9soudre extends/useContainer par identit\u00e9s de configuration\") and 03-analyse-commune.md \"Acceptation\" (same diagnostics in the CLI, the IDE and the build)"
  },
];
