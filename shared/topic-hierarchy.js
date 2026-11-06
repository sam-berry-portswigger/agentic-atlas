export function nestTopics(topics, parents = []) {
  const remaining = new Map(topics.map((t) => [t.id, t]));
  const result = [];
  for (const parent of parents) {
    const children = parent.topicIds
      .map((id) => remaining.get(id))
      .filter(Boolean);
    if (!children.length) continue;
    children.forEach((t) => remaining.delete(t.id));
    result.push({ ...parent, topics: children });
  }
  for (const topic of remaining.values())
    result.push({
      id: topic.id,
      name: topic.name,
      color: topic.color,
      topicIds: [topic.id],
      topics: [topic],
    });
  return result;
}
