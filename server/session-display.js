// Duplicate titles are legitimate native labels. Disambiguate real conversations
// with recorded start times, without inventing ancestry or another naming call.
export function disambiguateSessionTitles(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    delete s.sameTitle;
    const key = s.provider + "\0" + s.title.toLowerCase().trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  for (const group of groups.values())
    if (group.length > 1) for (const s of group) s.sameTitle = true;
}
