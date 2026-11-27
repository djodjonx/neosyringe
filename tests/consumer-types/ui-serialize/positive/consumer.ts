import {
  serializeGraph,
  serializeGraphWithErrors,
  type SerializableBorrowedRegistration,
  type SerializableDiagnostic,
  type SerializableGraph,
  type SerializableMultiRegistration,
  type SerializableNode,
  type SerializableRetentionEntry,
} from '@djodjonx/neosyringe-ui/serialize';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// The light entry carries the two serializers and the six types they return.
export const serializeReturnsGraph: Equal<ReturnType<typeof serializeGraph>, SerializableGraph> = true;
export const withErrorsReturnsGraph: Equal<ReturnType<typeof serializeGraphWithErrors>, SerializableGraph> = true;
export const nodes: Equal<SerializableGraph['nodes'], SerializableNode[]> = true;
export const multi: Equal<NonNullable<SerializableGraph['multiNodes']>, SerializableMultiRegistration[]> = true;
export const borrowed: Equal<NonNullable<SerializableGraph['borrowedRegistrations']>, SerializableBorrowedRegistration[]> = true;
export const retention: Equal<NonNullable<SerializableGraph['retention']>, SerializableRetentionEntry[]> = true;
export const diagnostics: Equal<NonNullable<SerializableGraph['diagnostics']>, SerializableDiagnostic[]> = true;
// One parameter on purpose: it is safe as an `Array.map` callback.
export const oneParameter: Equal<Parameters<typeof serializeGraph>['length'], 1> = true;
