// Ollama's omitted tag means :latest. Keep the saved spelling when the UI
// selects the explicit alias so cached embeddings and catalogue IDs stay valid.
export function sameModelName(a, b) {
  const key = (name) => name?.replace(/:latest$/, "");
  return typeof a === "string" && typeof b === "string" && key(a) === key(b);
}
export function preserveModelAlias(requested, saved) {
  return sameModelName(requested, saved) ? saved : requested;
}
