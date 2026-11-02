import { createHash } from "node:crypto";

export const focusSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    focus: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          text: { type: "string" },
          sources: { type: "array", items: { type: "integer" } },
          links: {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                sources: { type: "array", items: { type: "integer" } },
              },
              required: ["title", "sources"],
            },
          },
        },
        required: ["title", "text", "sources", "links"],
      },
    },
  },
  required: ["summary", "focus"],
};

// Give each project one primary paragraph. Extra objectives are an explicit
// exception, so implementation phases cannot silently become separate projects.
export function projectFocusSchema(groups) {
  const item = focusSchema.properties.focus.items;
  return {
    type: "object",
    properties: {
      summary: { type: "string" },
      projects: {
        type: "object",
        properties: Object.fromEntries(
          groups.map((group) => [
            group.project,
            {
              ...item,
              properties: {
                ...item.properties,
                independentObjectives: {
                  type: "array",
                  maxItems: 2,
                  items: item,
                },
              },
              required: [...item.required, "independentObjectives"],
            },
          ]),
        ),
        required: groups.map((group) => group.project),
      },
    },
    required: ["summary", "projects"],
  };
}
export function projectFocus(result, groups) {
  return {
    summary: result.summary,
    focus: groups.flatMap((group) => {
      const project = result.projects?.[group.project];
      return project
        ? [
            project,
            ...(Array.isArray(project.independentObjectives)
              ? project.independentObjectives.slice(0, 2)
              : []),
          ]
        : [];
    }),
  };
}

// Short citation numbers are easier for local models than copying opaque excerpt hashes.
export function focusContext(groups) {
  const sources = [];
  const ids = new Map();
  const evidence = groups.map((group) => ({
    ...(group.project
      ? { project: group.project }
      : { cluster: group.cluster }),
    evidence: group.sources.map((source) => {
      let number = ids.get(source.id);
      if (!number) {
        number = sources.length + 1;
        ids.set(source.id, number);
        sources.push({ ...source, clusters: [] });
      }
      const saved = sources[number - 1];
      const cluster = group.project ? source.cluster : group.cluster;
      if (!saved.clusters.includes(cluster)) saved.clusters.push(cluster);
      return number;
    }),
  }));
  return { groups: evidence, sources };
}
export function cleanFocus(value, sources, scope) {
  const focus = (Array.isArray(value?.focus) ? value.focus : [])
    .slice(0, 6)
    .flatMap((item) => {
      const cited = [
        ...new Set(Array.isArray(item.sources) ? item.sources : []),
      ]
        .filter((n) => Number.isInteger(n) && sources[n - 1])
        .map((n) => sources[n - 1]);
      const title =
        typeof item.title === "string" ? item.title.trim().slice(0, 100) : "";
      const text =
        typeof item.text === "string" ? item.text.trim().slice(0, 1000) : "";
      const inPeriod = cited.some(
        (s) =>
          (!scope.start || s.timestamp >= scope.start) &&
          (!scope.end || s.timestamp < scope.end),
      );
      if (!title || !text || !cited.length || !inPeriod) return [];
      const sourceIds = cited.map((s) => s.id);
      const links = (Array.isArray(item.links) ? item.links : [])
        .slice(0, 3)
        .flatMap((link) => {
          const refs = [
            ...new Set(Array.isArray(link.sources) ? link.sources : []),
          ]
            .filter(
              (n) =>
                Number.isInteger(n) &&
                sources[n - 1] &&
                cited.some((s) => s.id === sources[n - 1].id),
            )
            .map((n) => sources[n - 1]);
          return typeof link.title === "string" &&
            link.title.trim() &&
            refs.length
            ? [
                {
                  title: link.title.trim().slice(0, 100),
                  sourceIds: refs.map((s) => s.id),
                  cluster: refs[0].clusters[0],
                },
              ]
            : [];
        });
      return [
        {
          id: createHash("sha256")
            .update(JSON.stringify({ title, text, sourceIds }))
            .digest("hex")
            .slice(0, 16),
          title,
          text,
          sourceIds,
          links,
          clusters: [...new Set(cited.flatMap((s) => s.clusters))],
        },
      ];
    });
  if (!focus.length)
    throw new Error(
      "The local model returned no supported focus items. Please retry.",
    );
  return focus;
}

// Existing overviews remain readable while the fast version is refreshed.
export function workItems(data) {
  return (data.overview?.focus || []).map((item, i) => ({
    ...item,
    id: item.id || `legacy-${i}`,
    title:
      item.title ||
      data.topics.find((t) => item.clusters.includes(t.cluster))?.title ||
      "Work item",
    links: item.links?.length
      ? item.links
      : [
          ...new Map(
            data.topics
              .filter((t) => item.clusters.includes(t.cluster))
              .map((t) => [
                t.title,
                { title: t.title, sourceIds: t.sourceIds, cluster: t.cluster },
              ]),
          ).values(),
        ]
          .filter((link) => link.sourceIds.length)
          .slice(0, 3),
    sourceIds: item.sourceIds || [
      ...new Set(
        data.topics
          .filter((t) => item.clusters.includes(t.cluster))
          .flatMap((t) => t.sourceIds),
      ),
    ],
  }));
}
