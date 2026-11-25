export * from './Analyzer';
export { snapshotFor, SnapshotAnalysis, listedCaptures, type AnalysisAdapters, type ProjectSnapshot } from './snapshot';
export {
  assertLocalReferences,
  containerIROf,
  diagnosticIROf,
  type ContainerIR,
  type DependencyRef,
  type DiagnosticIR,
  type RegistrationIR,
  type SourceSpan,
} from './ir';
export { GraphAdapter, graphsFromSnapshot, mergedGraphFromSnapshot, positionsOfCall, type AdapterEnv } from './graphAdapter';
export { resolveProjectConfig } from '../resolveProjectConfig';
export type { ResolvedProjectConfig } from '../resolveProjectConfig';
export * from './types';
export * from './shared';

// New modular architecture
export * from './collectors';
export * from './validators';
export * from './resolvers';
export * from './errors';

