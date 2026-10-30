#!/usr/bin/env node
// scripts/ci/required-results.mjs
// Reads JOB_RESULTS (GitHub's toJSON(needs)) and exits 1 unless every
// job result is "success". A skipped job is not a success.
const raw = process.env.JOB_RESULTS;
if (!raw) {
  console.error('JOB_RESULTS is missing');
  process.exit(1);
}

let needs;
try {
  needs = JSON.parse(raw);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`JOB_RESULTS is not JSON: ${detail}`);
  process.exit(1);
}

if (!needs || typeof needs !== 'object' || Array.isArray(needs)) {
  console.error('JOB_RESULTS is not an object');
  process.exit(1);
}

const bad = [];
for (const [name, job] of Object.entries(needs)) {
  if (!job || typeof job !== 'object' || job.result !== 'success') {
    const result = job && typeof job === 'object' ? job.result : undefined;
    bad.push(`${name}=${result}`);
  }
}

if (bad.length > 0) {
  for (const line of bad) console.error(line);
  process.exit(1);
}
