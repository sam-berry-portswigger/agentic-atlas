import { familyRoots } from "./today-layout.js";

export function unreadFamilyCount(sessions, edges) {
  const { root } = familyRoots(sessions, edges);
  return new Set(sessions.filter((s) => s.unread).map((s) => root(s.id))).size;
}

// Opening a parent acknowledges its current descendants, using the same
// recorded family boundaries as the cards. A child never reads its siblings.
export function sessionReadTargets(id, sessions, edges) {
  const { parent } = familyRoots(sessions, edges);
  return sessions.filter((s) => {
    if (!s.lastResponseAt) return false;
    let current = s.id;
    while (current) {
      if (current === id) return true;
      current = parent.get(current);
    }
    return false;
  });
}
