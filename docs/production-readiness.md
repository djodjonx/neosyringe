# Production readiness

Base SHA: `ba192b457f0efa13149cc7f64a647c7d9b5c86b3`

## Evidence

A proof that is missing, failing, recorded for another SHA, or recorded for another archive blocks qualification. `assertCandidateReady` reports `missing, stale or failing evidence: <id>`.

## Contract matrix

Each cell compiles a real config through the analyzer and the generator, runs it, and checks the shared behaviour. The same assertions run on the optimized emitter and on the reference emitter. The test title is `T00 <profile> <mode> <timing> <owner>`.

| Profile | Mode | Timing | Owner | Test |
|---------|------|--------|-------|------|
| full | open | sync | root | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 full open sync root` |
| full | open | sync | scope | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 full open sync scope` |
| full | open | sync | parent | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 full open sync parent` |
| full | open | async | root | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 full open async root` |
| full | open | async | scope | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 full open async scope` |
| full | open | async | parent | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 full open async parent` |
| full | closed | sync | root | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 full closed sync root` |
| full | closed | sync | scope | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 full closed sync scope` |
| full | closed | sync | parent | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 full closed sync parent` |
| full | closed | async | root | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 full closed async root` |
| full | closed | async | scope | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 full closed async scope` |
| full | closed | async | parent | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 full closed async parent` |
| minimal | open | sync | root | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 minimal open sync root` |
| minimal | open | sync | scope | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 minimal open sync scope` |
| minimal | open | sync | parent | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 minimal open sync parent` |
| minimal | open | async | root | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 minimal open async root` |
| minimal | open | async | scope | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 minimal open async scope` |
| minimal | open | async | parent | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 minimal open async parent` |
| minimal | closed | sync | root | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 minimal closed sync root` |
| minimal | closed | sync | scope | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 minimal closed sync scope` |
| minimal | closed | sync | parent | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 minimal closed sync parent` |
| minimal | closed | async | root | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 minimal closed async root` |
| minimal | closed | async | scope | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 minimal closed async scope` |
| minimal | closed | async | parent | `packages/core/tests/generator/t00-contract-matrix.test.ts::T00 minimal closed async parent` |
