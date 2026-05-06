import { topologicalSort } from './dist/index.js';

// Test 1: Normal case - should produce deps before dependents
const nodes1 = new Map([
  ['a', { id: 'a', dependencies: [] }],
  ['b', { id: 'b', dependencies: ['a'] }],
  ['c', { id: 'c', dependencies: ['a', 'b'] }],
]);
const sorted1 = topologicalSort(nodes1);
console.log('✓ Normal case:', sorted1);
console.assert(sorted1.indexOf('a') < sorted1.indexOf('b'), 'a before b');
console.assert(sorted1.indexOf('b') < sorted1.indexOf('c'), 'b before c');

// Test 2: Cycle detection
const nodes2 = new Map([
  ['a', { id: 'a', dependencies: ['b'] }],
  ['b', { id: 'b', dependencies: ['a'] }],
]);
try {
  topologicalSort(nodes2);
  console.error('✗ Should have detected cycle');
  process.exit(1);
} catch (err) {
  console.log('✓ Cycle detected:', err.message);
  console.assert(err.message.includes('[Generator] Cycle detected involving'), 'Correct error message');
}

console.log('\n✓ All topological sort tests passed');
