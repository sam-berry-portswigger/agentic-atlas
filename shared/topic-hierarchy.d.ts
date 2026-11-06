export function nestTopics<
  T extends { id: number | null; name: string; color: string },
>(
  topics: T[],
  parents?: { id: number; name: string; color: string; topicIds: number[] }[],
): {
  id: number | null;
  name: string;
  color: string;
  topicIds: (number | null)[];
  topics: T[];
}[];
