// A dropped HTTP response is not proof that an update failed. Reconcile only
// the exact user-approved commit against the server's durable update marker.
export function appliedUpdate(state, expectedSha) {
  return !!(
    state &&
    typeof expectedSha === "string" &&
    /^[a-f0-9]{40,64}$/.test(expectedSha) &&
    state.currentSha === expectedSha &&
    (state.restartRequired || state.updatedVersion === expectedSha)
  );
}
