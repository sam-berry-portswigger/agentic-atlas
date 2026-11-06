// Incremental catalogues can advance without changing their stable version ID.
// This reads only the small published metadata, never archive content or hashes.
export function catalogueRevision(analysis) {
  if (!analysis?.version) return null;
  return JSON.stringify([
    analysis.version,
    analysis.contentUpdatedAt || null,
    analysis.assignmentsUpdatedAt || null,
    analysis.mapUpdatedAt || null,
    analysis.hierarchyUpdatedAt || null,
    !!analysis.mapPending,
  ]);
}
