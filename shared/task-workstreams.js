// Offer the same saved workstreams as the Explore legend in the selected range.
// Historical owners stay readable on tasks, but are not new-task destinations.
/**
 * @param {{ points: { cluster: number }[], topics: { cluster: number, title: string }[] }} map
 * @param {{ id: number, name: string, historical?: boolean } | null} selected
 */
export function taskStreamOptions(map, selected = null) {
  const visible = new Set(map.points.map((point) => point.cluster));
  const options = map.topics
    .filter((topic) => visible.has(topic.cluster))
    .map((topic) => ({ value: String(topic.cluster), label: topic.title }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (
    selected &&
    !options.some((option) => option.value === String(selected.id))
  )
    options.push({
      value: String(selected.id),
      label: `${selected.name} · ${selected.historical ? "Previous workstream" : "Outside this view"}`,
    });
  return options;
}
