#!/usr/bin/env node
// Positional paths only. No arguments is a clean run.
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { assertNoUnsafeTypes } from './lib/no-unsafe-types.mjs';

const files = process.argv.slice(2);
try {
  for (const file of files) {
    assertNoUnsafeTypes(ts, readFileSync(file, 'utf8'), file);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
